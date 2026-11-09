import {
  defaultEmailTemplates,
  emailMessages,
  emailTemplateFingerprint,
  emailTemplates,
  events,
  type Executor,
} from '@tix/db';
import { EMAIL_TEMPLATE_KEYS, SUPPORTED_LOCALES, type EmailTemplateKey } from '@tix/shared';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SendMailOptions } from 'nodemailer';
import { DomainError, type CoreContext } from '../context';
import {
  prepareEmailTemplate,
  renderTemplateDraft,
  sampleEmailVariables,
  type TemplateDraft,
  type TemplateIssue,
  type TemplateValidation,
} from './editor';
import type { EmailTemplateRow } from './render';
import { smtpSender, type MailSender } from './transport';
import { shopVariables } from './variables';

/** Admin service of the e-mail template editor (list, edit, override, reset, test send). */

export const EMAIL_TEMPLATE_LOCALES = SUPPORTED_LOCALES;
export type EmailTemplateLocale = (typeof EMAIL_TEMPLATE_LOCALES)[number];

export function isTemplateKey(value: string): value is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export function isTemplateLocale(value: string): value is EmailTemplateLocale {
  return (EMAIL_TEMPLATE_LOCALES as readonly string[]).includes(value);
}

/** The shipped default for a key/locale (what "reset to default" restores). */
export function defaultEmailTemplate(key: EmailTemplateKey, locale: EmailTemplateLocale) {
  const found = defaultEmailTemplates().find((t) => t.key === key && t.locale === locale);
  if (!found) throw new DomainError('EMAIL_TEMPLATE_NOT_FOUND', 'No such template', 404);
  return found;
}

export interface TemplateOverviewEntry {
  key: EmailTemplateKey;
  locales: Record<
    EmailTemplateLocale,
    { exists: boolean; isActive: boolean; isDefault: boolean; updatedAt: Date | null }
  >;
  /** Event overrides (event id, title, locale). */
  overrides: { eventId: string; eventTitle: string; locale: string; isActive: boolean }[];
}

/** All keys with the status of their global EN/DE templates and event overrides. */
export async function listEmailTemplates(db: Executor): Promise<TemplateOverviewEntry[]> {
  const [rows, overrides] = await Promise.all([
    db.select().from(emailTemplates).where(isNull(emailTemplates.eventId)),
    db
      .select({
        key: emailTemplates.key,
        eventId: emailTemplates.eventId,
        locale: emailTemplates.locale,
        isActive: emailTemplates.isActive,
        eventTitle: events.title,
      })
      .from(emailTemplates)
      .innerJoin(events, eq(events.id, emailTemplates.eventId))
      .where(isNotNull(emailTemplates.eventId))
      .orderBy(asc(events.title), asc(emailTemplates.locale)),
  ]);
  const defaults = new Map(
    defaultEmailTemplates().map((t) => [`${t.key}|${t.locale}`, emailTemplateFingerprint(t)]),
  );
  return EMAIL_TEMPLATE_KEYS.map((key) => ({
    key,
    locales: Object.fromEntries(
      EMAIL_TEMPLATE_LOCALES.map((locale) => {
        const row = rows.find((r) => r.key === key && r.locale === locale);
        return [
          locale,
          {
            exists: Boolean(row),
            isActive: row?.isActive ?? false,
            isDefault: row
              ? emailTemplateFingerprint(row) === defaults.get(`${key}|${locale}`)
              : false,
            updatedAt: row?.updatedAt ?? null,
          },
        ];
      }),
    ) as TemplateOverviewEntry['locales'],
    overrides: overrides
      .filter((o) => o.key === key && o.eventId)
      .map((o) => ({
        eventId: o.eventId!,
        eventTitle: o.eventTitle,
        locale: o.locale,
        isActive: o.isActive,
      })),
  }));
}

export interface EditableTemplate {
  /** Stored row (global or event override); null when the event has no override yet. */
  row: EmailTemplateRow | null;
  /** Effective content to edit: the row, or the global template for a not yet created override. */
  draft: TemplateDraft & { isActive: boolean };
  isDefault: boolean;
}

async function findRow(
  db: Executor,
  key: EmailTemplateKey,
  locale: string,
  eventId: string | null,
): Promise<EmailTemplateRow | null> {
  const [row] = await db
    .select()
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.key, key),
        eq(emailTemplates.locale, locale),
        eventId ? eq(emailTemplates.eventId, eventId) : isNull(emailTemplates.eventId),
      ),
    );
  return row ?? null;
}

/** Loads a template for editing; a missing global row is restored from the default. */
export async function getEditableEmailTemplate(
  db: Executor,
  key: EmailTemplateKey,
  locale: EmailTemplateLocale,
  eventId: string | null,
): Promise<EditableTemplate> {
  if (eventId) await requireEvent(db, eventId);
  const fallback = defaultEmailTemplate(key, locale);
  const row = await findRow(db, key, locale, eventId);
  const source = row ?? (eventId ? await findRow(db, key, locale, null) : null);
  const content = source ?? { ...fallback, isActive: true };
  return {
    row,
    draft: {
      subject: content.subject,
      bodyHtml: content.bodyHtml,
      bodyText: content.bodyText,
      isActive: content.isActive,
    },
    isDefault: emailTemplateFingerprint(content) === emailTemplateFingerprint(fallback),
  };
}

async function requireEvent(db: Executor, eventId: string): Promise<{ title: string }> {
  const [event] = await db
    .select({ title: events.title })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  return event;
}

export interface SaveTemplateInput extends TemplateDraft {
  key: EmailTemplateKey;
  locale: EmailTemplateLocale;
  eventId: string | null;
  isActive: boolean;
  userId: string | null;
}

export interface SaveTemplateResult {
  row: EmailTemplateRow;
  before: TemplateDraft | null;
  warnings: TemplateIssue[];
}

/** Thrown when the template has syntax errors (unbalanced sections …). */
export class EmailTemplateInvalidError extends DomainError {
  constructor(readonly validation: TemplateValidation) {
    super('EMAIL_TEMPLATE_INVALID', 'The template contains errors', 422);
  }
}

/** Sanitises, validates and stores a template (creates the row for new event overrides). */
export async function saveEmailTemplate(
  ctx: CoreContext,
  db: Executor,
  input: SaveTemplateInput,
): Promise<SaveTemplateResult> {
  if (input.eventId) await requireEvent(db, input.eventId);
  const { draft, validation } = prepareEmailTemplate(input.key, input, {
    baseUrl: ctx.appUrl ?? null,
  });
  if (validation.errors.length > 0) throw new EmailTemplateInvalidError(validation);
  if (!draft.subject || !draft.bodyHtml) {
    throw new DomainError('EMAIL_TEMPLATE_EMPTY', 'Subject and body are required', 422);
  }
  const existing = await findRow(db, input.key, input.locale, input.eventId);
  const values = {
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
    bodyText: draft.bodyText,
    isActive: input.isActive,
    updatedByUserId: input.userId,
    updatedAt: new Date(),
  };
  const [row] = existing
    ? await db
        .update(emailTemplates)
        .set(values)
        .where(eq(emailTemplates.id, existing.id))
        .returning()
    : await db
        .insert(emailTemplates)
        .values({ key: input.key, locale: input.locale, eventId: input.eventId, ...values })
        .returning();
  return {
    row: row!,
    before: existing
      ? { subject: existing.subject, bodyHtml: existing.bodyHtml, bodyText: existing.bodyText }
      : null,
    warnings: validation.warnings,
  };
}

/** Creates an event override as a copy of the global template (idempotent). */
export async function createEmailTemplateOverride(
  db: Executor,
  params: {
    key: EmailTemplateKey;
    locale: EmailTemplateLocale;
    eventId: string;
    userId: string | null;
  },
): Promise<EmailTemplateRow> {
  await requireEvent(db, params.eventId);
  const existing = await findRow(db, params.key, params.locale, params.eventId);
  if (existing) return existing;
  const global = await findRow(db, params.key, params.locale, null);
  const source = global ?? defaultEmailTemplate(params.key, params.locale);
  const [row] = await db
    .insert(emailTemplates)
    .values({
      key: params.key,
      locale: params.locale,
      eventId: params.eventId,
      subject: source.subject,
      bodyHtml: source.bodyHtml,
      bodyText: source.bodyText,
      isActive: true,
      updatedByUserId: params.userId,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? (await findRow(db, params.key, params.locale, params.eventId))!;
}

/** Removes an event override (the global template applies again). */
export async function deleteEmailTemplateOverride(
  db: Executor,
  params: { key: EmailTemplateKey; locale: EmailTemplateLocale; eventId: string },
): Promise<void> {
  const deleted = await db
    .delete(emailTemplates)
    .where(
      and(
        eq(emailTemplates.key, params.key),
        eq(emailTemplates.locale, params.locale),
        eq(emailTemplates.eventId, params.eventId),
      ),
    )
    .returning({ id: emailTemplates.id });
  if (deleted.length === 0) {
    throw new DomainError('EMAIL_TEMPLATE_NOT_FOUND', 'No such override', 404);
  }
}

/** Restores the shipped default text (global template or event override). */
export async function resetEmailTemplate(
  db: Executor,
  params: {
    key: EmailTemplateKey;
    locale: EmailTemplateLocale;
    eventId: string | null;
    userId: string | null;
  },
): Promise<EmailTemplateRow> {
  if (params.eventId) await requireEvent(db, params.eventId);
  const target = defaultEmailTemplate(params.key, params.locale);
  const values = {
    subject: target.subject,
    bodyHtml: target.bodyHtml,
    bodyText: target.bodyText,
    isActive: true,
    updatedByUserId: params.userId,
    updatedAt: new Date(),
  };
  const existing = await findRow(db, params.key, params.locale, params.eventId);
  const [row] = existing
    ? await db
        .update(emailTemplates)
        .set(values)
        .where(eq(emailTemplates.id, existing.id))
        .returning()
    : await db
        .insert(emailTemplates)
        .values({ key: params.key, locale: params.locale, eventId: params.eventId, ...values })
        .returning();
  return row!;
}

export type DraftTestResult =
  { ok: true; messageId: string; providerMessageId: string | null } | { ok: false; error: string };

/**
 * Sends the (unsaved) draft with sample data to `to`: subject is prefixed with "[Test]". The
 * attempt is logged in the outbox like any other e-mail (status SENT / FAILED, no job).
 */
export async function sendDraftTestEmail(
  ctx: CoreContext,
  params: {
    key: EmailTemplateKey;
    locale: EmailTemplateLocale;
    to: string;
    draft: TemplateDraft;
    sender?: MailSender;
  },
): Promise<DraftTestResult> {
  const { draft, validation } = prepareEmailTemplate(params.key, params.draft, {
    baseUrl: ctx.appUrl ?? null,
  });
  if (validation.errors.length > 0) {
    return { ok: false, error: validation.errors.map((e) => e.detail).join('; ') };
  }
  const { variables: shop } = await shopVariables(ctx, params.locale);
  const rendered = renderTemplateDraft(
    draft,
    sampleEmailVariables(params.key, params.locale, shop, {
      orderUrl: ctx.appUrl ?? undefined,
      recipient: params.to,
    }),
  );
  const subject = `[Test] ${rendered.subject}`;
  let providerMessageId: string | null = null;
  try {
    const sender = params.sender ?? (await smtpSender(ctx));
    const mail: SendMailOptions = {
      from: sender.from,
      to: params.to,
      replyTo: sender.replyTo,
      subject,
      html: rendered.html,
      text: rendered.text,
      headers: { 'Auto-Submitted': 'auto-generated' },
    };
    const info = (await sender.transporter.sendMail(mail)) as { messageId?: string };
    providerMessageId = info.messageId ?? null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await logTest(ctx, params, subject, 'FAILED', null, error);
    return { ok: false, error };
  }
  const messageId = await logTest(ctx, params, subject, 'SENT', providerMessageId, null);
  return { ok: true, messageId, providerMessageId };
}

async function logTest(
  ctx: CoreContext,
  params: { key: EmailTemplateKey; to: string },
  subject: string,
  status: 'SENT' | 'FAILED',
  providerMessageId: string | null,
  lastError: string | null,
): Promise<string> {
  const [row] = await ctx.db
    .insert(emailMessages)
    .values({
      templateKey: params.key,
      toEmail: params.to,
      subject,
      status,
      attempts: 1,
      providerMessageId,
      lastError: lastError?.slice(0, 2_000) ?? null,
      sentAt: status === 'SENT' ? sql`now()` : null,
    })
    .returning({ id: emailMessages.id });
  return row!.id;
}
