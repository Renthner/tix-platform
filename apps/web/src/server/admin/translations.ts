'use server';

import {
  DomainError,
  GLOBAL_TRANSLATION_SCOPES,
  TRANSLATION_SCOPES,
  saveGlobalTranslations,
  type GlobalTranslationScope,
  saveTranslations,
  type TranslationScope,
  type TranslationUpdate,
} from '@tix/core';
import { SUPPORTED_LOCALES, TRANSLATABLE_FIELDS, type TranslatableEntity } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { sanitizeRichText } from '@/server/rich-text';
import { audit } from './audit';
import { EDIT_LOCALE_COOKIE } from './edit-locale';
import { formError, success } from './form';

function parseTranslationFields(fd: FormData): TranslationUpdate[] {
  const byRow = new Map<string, TranslationUpdate>();
  for (const [key, value] of fd.entries()) {
    if (typeof value !== 'string') continue;
    const match = /^t:([A-Za-z]+):([0-9a-f-]{36}):([A-Za-z]+)$/.exec(key);
    if (!match) continue;
    const [, entity, id, field] = match as unknown as [string, TranslatableEntity, string, string];
    if (!(entity in TRANSLATABLE_FIELDS)) continue;
    const row = byRow.get(`${entity}:${id}`) ?? { entity, id, fields: {} };
    row.fields[field] = value;
    byRow.set(`${entity}:${id}`, row);
  }
  return [...byRow.values()];
}

/** Remembers the content language of the admin ('' = base language). */
export async function setEditLocaleAction(locale: string): Promise<void> {
  await requireAdmin(['EVENT_MANAGER', 'FINANCE']);
  const store = await cookies();
  if ((SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    store.set(EDIT_LOCALE_COOKIE, locale, {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
    });
  } else {
    store.delete(EDIT_LOCALE_COOKIE);
  }
  revalidatePath('/', 'layout');
}

/**
 * Saves the translations of one event tab. The target locale travels inside the form (hidden
 * `locale` field), never from the cookie, so switching the language in another tab cannot
 * redirect a pending save. Field names: `t:<entity>:<id>:<field>`.
 */
export async function saveTranslationsAction(
  eventId: string,
  scope: TranslationScope,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!(TRANSLATION_SCOPES as readonly string[]).includes(scope)) return formError('generic');
  const locale = fd.get('locale');
  if (typeof locale !== 'string') return formError('generic');

  const updates = parseTranslationFields(fd);

  try {
    const core = getCore();
    await saveTranslations(core, {
      eventId,
      scope,
      locale,
      updates,
      sanitizeRich: sanitizeRichText,
    });
    await audit(core.db, session, 'event.translations', 'event', eventId, { scope, locale });
  } catch (err) {
    if (err instanceof DomainError) return formError(err.status === 404 ? 'notFound' : 'generic');
    throw err;
  }
  revalidatePath('/', 'layout');
  return success('saved');
}

/** Saves translations of global texts (global fees: FINANCE, global waiting room: EVENT_MANAGER). */
export async function saveGlobalTranslationsAction(
  scope: GlobalTranslationScope,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  if (!(GLOBAL_TRANSLATION_SCOPES as readonly string[]).includes(scope))
    return formError('generic');
  const session = await requireAdmin([scope === 'globalFees' ? 'FINANCE' : 'EVENT_MANAGER']);
  const locale = fd.get('locale');
  if (typeof locale !== 'string') return formError('generic');
  try {
    const core = getCore();
    await saveGlobalTranslations(core, {
      scope,
      locale,
      updates: parseTranslationFields(fd),
      sanitizeRich: sanitizeRichText,
    });
    await audit(core.db, session, 'translations.global', scope, null, { locale });
  } catch (err) {
    if (err instanceof DomainError) return formError(err.status === 404 ? 'notFound' : 'generic');
    throw err;
  }
  revalidatePath('/', 'layout');
  return success('saved');
}
