'use server';

import {
  DomainError,
  EMAIL_HTML_MAX_LENGTH,
  EmailTemplateInvalidError,
  createEmailTemplateOverride,
  deleteEmailTemplateOverride,
  htmlToText,
  isTemplateKey,
  isTemplateLocale,
  previewEmailTemplate,
  resetEmailTemplate,
  saveEmailTemplate,
  sanitizeEmailHtml,
  sendDraftTestEmail,
  type TemplateIssue,
} from '@tix/core';
import { withTransaction } from '@tix/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, formError, success, text, zodFieldErrors } from './form';

/**
 * E-mail template editor actions (SUPER_ADMIN). Content is sanitised and validated in the core
 * service; every mutation is audited in the same transaction.
 */

export type TemplateActionState = ActionState & {
  /** Syntax errors that blocked saving / warnings about unknown placeholders. */
  issues?: TemplateIssue[];
  warnings?: TemplateIssue[];
  /** Sanitised HTML as stored (the editor adopts it after saving). */
  savedHtml?: string;
};

const ROLES = ['SUPER_ADMIN'] as const;

const draftSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  bodyHtml: z.string().min(1).max(EMAIL_HTML_MAX_LENGTH),
  bodyText: z.string().max(100_000).optional(),
  isActive: z.boolean(),
});

function target(key: string, locale: string, eventId: string | null) {
  if (!isTemplateKey(key) || !isTemplateLocale(locale)) return null;
  if (eventId !== null && !z.uuid().safeParse(eventId).success) return null;
  return { key, locale, eventId };
}

function refresh(): void {
  revalidatePath('/', 'layout');
}

export async function saveEmailTemplateAction(
  key: string,
  locale: string,
  eventId: string | null,
  _prev: TemplateActionState,
  fd: FormData,
): Promise<TemplateActionState> {
  const session = await requireAdmin(ROLES);
  const t = target(key, locale, eventId);
  if (!t) return formError('notFound');
  const parsed = draftSchema.safeParse({
    subject: text(fd, 'subject'),
    bodyHtml: typeof fd.get('bodyHtml') === 'string' ? fd.get('bodyHtml') : undefined,
    bodyText: typeof fd.get('bodyText') === 'string' ? fd.get('bodyText') : undefined,
    isActive: flag(fd, 'isActive'),
  });
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const core = getCore();
  try {
    const result = await withTransaction(core.db, async (tx) => {
      const saved = await saveEmailTemplate(core, tx, {
        ...t,
        ...parsed.data,
        bodyText: parsed.data.bodyText ?? null,
        userId: session.userId,
      });
      await audit(
        tx,
        session,
        t.eventId ? 'emailTemplate.override.save' : 'emailTemplate.save',
        'email_template',
        saved.row.id,
        {
          key: t.key,
          locale: t.locale,
          eventId: t.eventId,
          isActive: parsed.data.isActive,
          subjectBefore: saved.before?.subject ?? null,
          subjectAfter: saved.row.subject,
          bodyChanged: saved.before?.bodyHtml !== saved.row.bodyHtml,
          textChanged: saved.before?.bodyText !== saved.row.bodyText,
        },
      );
      return saved;
    });
    refresh();
    return {
      ...success('saved'),
      warnings: result.warnings,
      savedHtml: result.row.bodyHtml,
    };
  } catch (err) {
    if (err instanceof EmailTemplateInvalidError) {
      return {
        ...fieldError({
          ...(err.validation.errors.some((e) => e.field === 'subject')
            ? { subject: 'invalid' }
            : {}),
          ...(err.validation.errors.some((e) => e.field !== 'subject')
            ? { bodyHtml: 'invalid' }
            : {}),
        }),
        issues: err.validation.errors,
      };
    }
    if (err instanceof DomainError) {
      return err.code === 'EMAIL_TEMPLATE_EMPTY'
        ? fieldError({ subject: 'required' })
        : formError(err.status === 404 ? 'notFound' : 'generic');
    }
    throw err;
  }
}

export async function resetEmailTemplateAction(
  key: string,
  locale: string,
  eventId: string | null,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  const t = target(key, locale, eventId);
  if (!t) return formError('notFound');
  try {
    await withTransaction(getCore().db, async (tx) => {
      const row = await resetEmailTemplate(tx, { ...t, userId: session.userId });
      await audit(tx, session, 'emailTemplate.reset', 'email_template', row.id, {
        key: t.key,
        locale: t.locale,
        eventId: t.eventId,
      });
    });
  } catch (err) {
    if (err instanceof DomainError) return formError(err.status === 404 ? 'notFound' : 'generic');
    throw err;
  }
  refresh();
  return success('saved');
}

export async function createEmailTemplateOverrideAction(
  key: string,
  locale: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  const eventId = text(fd, 'eventId') ?? null;
  const t = target(key, locale, eventId);
  if (!t || !t.eventId) return fieldError({ eventId: 'required' });
  const eventIdValue = t.eventId;
  try {
    await withTransaction(getCore().db, async (tx) => {
      const row = await createEmailTemplateOverride(tx, {
        key: t.key,
        locale: t.locale,
        eventId: eventIdValue,
        userId: session.userId,
      });
      await audit(tx, session, 'emailTemplate.override.create', 'email_template', row.id, {
        key: t.key,
        locale: t.locale,
        eventId: eventIdValue,
      });
    });
  } catch (err) {
    if (err instanceof DomainError) return formError('notFound');
    throw err;
  }
  refresh();
  return success('created');
}

export async function deleteEmailTemplateOverrideAction(
  key: string,
  locale: string,
  eventId: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  const t = target(key, locale, eventId);
  if (!t || !t.eventId) return formError('notFound');
  const eventIdValue = t.eventId;
  try {
    await withTransaction(getCore().db, async (tx) => {
      await deleteEmailTemplateOverride(tx, {
        key: t.key,
        locale: t.locale,
        eventId: eventIdValue,
      });
      await audit(tx, session, 'emailTemplate.override.delete', 'email_template', null, {
        key: t.key,
        locale: t.locale,
        eventId: eventIdValue,
      });
    });
  } catch (err) {
    if (err instanceof DomainError) return formError('notFound');
    throw err;
  }
  refresh();
  return success('deleted');
}

// ─── Preview, plain-text generation, test e-mail ────────────────────────────

export interface TemplateDraftInput {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export type PreviewResult =
  | {
      ok: true;
      subject: string;
      html: string;
      text: string;
      missing: string[];
      warnings: TemplateIssue[];
      errors: TemplateIssue[];
    }
  | { ok: false };

const previewSchema = z.object({
  subject: z.string().max(300),
  bodyHtml: z.string().max(EMAIL_HTML_MAX_LENGTH),
  bodyText: z.string().max(100_000),
});

/** Renders an unsaved draft through the real renderer with sample order data. */
export async function previewEmailTemplateAction(
  key: string,
  locale: string,
  draft: TemplateDraftInput,
): Promise<PreviewResult> {
  await requireAdmin(ROLES);
  const t = target(key, locale, null);
  const parsed = previewSchema.safeParse(draft);
  if (!t || !parsed.success) return { ok: false };
  const result = await previewEmailTemplate(getCore(), t.key, t.locale, {
    ...parsed.data,
    bodyText: parsed.data.bodyText.trim() ? parsed.data.bodyText : null,
  });
  return {
    ok: true,
    subject: result.subject,
    html: result.html,
    text: result.text,
    missing: result.missing,
    warnings: result.validation.warnings,
    errors: result.validation.errors,
  };
}

/** Plain-text body derived from the HTML body (placeholders stay in place). */
export async function generateTemplateTextAction(bodyHtml: string): Promise<string> {
  await requireAdmin(ROLES);
  if (typeof bodyHtml !== 'string' || bodyHtml.length > EMAIL_HTML_MAX_LENGTH) return '';
  return htmlToText(sanitizeEmailHtml(bodyHtml, { baseUrl: getCore().appUrl ?? null }));
}

export type TemplateTestResult =
  | { status: 'success'; to: string }
  | { status: 'error'; code: 'invalid' | 'notConfigured' | 'failed'; message?: string };

/** Sends the unsaved draft with sample data to the signed-in admin. */
export async function sendEmailTemplateTestAction(
  key: string,
  locale: string,
  draft: TemplateDraftInput,
): Promise<TemplateTestResult> {
  const session = await requireAdmin(ROLES);
  const t = target(key, locale, null);
  const parsed = previewSchema.safeParse(draft);
  if (!t || !parsed.success) return { status: 'error', code: 'invalid' };
  const core = getCore();
  const result = await sendDraftTestEmail(core, {
    key: t.key,
    locale: t.locale,
    to: session.email,
    draft: { ...parsed.data, bodyText: parsed.data.bodyText.trim() ? parsed.data.bodyText : null },
  });
  await audit(core.db, session, 'emailTemplate.test', 'email_template', null, {
    key: t.key,
    locale: t.locale,
    to: session.email,
    ok: result.ok,
    ...(result.ok ? { messageId: result.messageId } : { error: result.error }),
  });
  return result.ok
    ? { status: 'success', to: session.email }
    : result.reason === 'validation'
      ? { status: 'error', code: 'invalid' }
      : result.reason === 'smtpNotConfigured'
        ? { status: 'error', code: 'notConfigured' }
        : { status: 'error', code: 'failed', message: result.error };
}
