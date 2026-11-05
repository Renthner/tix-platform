'use server';

import { getSetting, saveSetting } from '@tix/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, success, text, zodFieldErrors } from './form';

/** Setting groups editable on /admin/settings (secret groups have their own screens later). */
export type EditableSettingKey = 'general' | 'branding' | 'checkout' | 'seatDisplay';

/**
 * Required integer field: empty → "required" (instead of silently applying the schema default).
 * Returns undefined when invalid; the error is collected.
 */
function requiredInt(
  fd: FormData,
  name: string,
  errors: Partial<Record<string, FieldErrorCode>>,
): number | undefined {
  const raw = text(fd, name);
  if (raw === undefined) {
    errors[name] = 'required';
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    errors[name] = 'invalid';
    return undefined;
  }
  return n;
}

async function readInput(
  key: EditableSettingKey,
  fd: FormData,
  errors: Partial<Record<string, FieldErrorCode>>,
): Promise<Record<string, unknown>> {
  switch (key) {
    case 'general':
      return {
        shopName: text(fd, 'shopName') ?? '',
        defaultLocale: text(fd, 'defaultLocale'),
        defaultCurrency: text(fd, 'defaultCurrency')?.toUpperCase(),
        defaultTimeZone: text(fd, 'defaultTimeZone'),
        supportEmail: text(fd, 'supportEmail'),
      };
    case 'branding': {
      // Logo / favicon are managed by the upload screen – keep the stored values.
      const current = await getSetting(getCore(), 'branding');
      return {
        logoAssetId: current.logoAssetId,
        faviconAssetId: current.faviconAssetId,
        primaryColor: text(fd, 'primaryColor'),
        accentColor: text(fd, 'accentColor'),
        imprintUrl: text(fd, 'imprintUrl'),
        privacyUrl: text(fd, 'privacyUrl'),
        termsUrl: text(fd, 'termsUrl'),
        footerText: text(fd, 'footerText'),
      };
    }
    case 'checkout': {
      const perCustomer = text(fd, 'maxTicketsPerCustomer');
      if (perCustomer !== undefined && !Number.isInteger(Number(perCustomer)))
        errors.maxTicketsPerCustomer = 'invalid';
      // Empty = unlimited.
      const perOrder = text(fd, 'maxTicketsPerOrder');
      if (perOrder !== undefined && !Number.isInteger(Number(perOrder)))
        errors.maxTicketsPerOrder = 'invalid';
      return {
        cartLockTtlSeconds: requiredInt(fd, 'cartLockTtlSeconds', errors),
        paymentGraceSeconds: requiredInt(fd, 'paymentGraceSeconds', errors),
        maxTicketsPerOrder: perOrder === undefined ? null : Number(perOrder),
        maxTicketsPerCustomer: perCustomer === undefined ? null : Number(perCustomer),
        manualSeatSelectionEnabled: flag(fd, 'manualSeatSelectionEnabled'),
        bestAvailableEnabled: flag(fd, 'bestAvailableEnabled'),
        orphanSeatRuleEnabled: flag(fd, 'orphanSeatRuleEnabled'),
        companionSeatsRequireWheelchair: flag(fd, 'companionSeatsRequireWheelchair'),
        requireTermsAcceptance: flag(fd, 'requireTermsAcceptance'),
      };
    }
    case 'seatDisplay':
      return {
        inOtherCartColor: text(fd, 'inOtherCartColor'),
        soldColor: text(fd, 'soldColor'),
        blockedColor: text(fd, 'blockedColor'),
        selectionColor: text(fd, 'selectionColor'),
        markUnavailableWithCross: flag(fd, 'markUnavailableWithCross'),
        selectionStyle: text(fd, 'selectionStyle'),
      };
  }
}

export async function saveSettingsAction(
  key: EditableSettingKey,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const errors: Partial<Record<string, FieldErrorCode>> = {};
  const input = await readInput(key, fd, errors);
  if (Object.keys(errors).length > 0) return fieldError(errors);

  const core = getCore();
  let saved: unknown;
  try {
    saved = await saveSetting(core, key, input, session.userId);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const fields = zodFieldErrors(err);
      if (fields.supportEmail === 'invalid') fields.supportEmail = 'email';
      for (const url of ['imprintUrl', 'privacyUrl', 'termsUrl'])
        if (fields[url]) fields[url] = 'url';
      if (fields.defaultTimeZone) fields.defaultTimeZone = 'timeZone';
      return fieldError(fields);
    }
    throw err;
  }
  await audit(core.db, session, 'settings.update', 'system_setting', key, { value: saved });
  revalidatePath('/', 'layout');
  return success('saved');
}
