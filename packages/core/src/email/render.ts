import { emailTemplates, type Executor } from '@tix/db';
import type { EmailTemplateKey } from '@tix/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { loadOrderDocumentData } from '../documents/order-data';
import { getSetting } from '../settings';
import { htmlToText, renderTemplate, type TemplateVariables } from './template';
import { customerVariables, orderVariables, shopVariables } from './variables';

export type EmailTemplateRow = typeof emailTemplates.$inferSelect;

/** No active template exists for the key in any candidate locale. */
export class EmailTemplateMissingError extends Error {
  override name = 'EmailTemplateMissingError';
}

/** Ordered, de-duplicated locale candidates: requested, its language, shop default, English. */
export function localeCandidates(requested: string | null | undefined, shopDefault: string) {
  const list = [requested, requested?.split('-')[0], shopDefault, shopDefault.split('-')[0], 'en'];
  return [...new Set(list.filter((l): l is string => Boolean(l)))];
}

/**
 * Picks the template: for each locale candidate the event-specific override first, then the
 * global template. Inactive templates are ignored.
 */
export async function resolveEmailTemplate(
  db: Executor,
  key: EmailTemplateKey,
  eventId: string | null,
  locales: readonly string[],
): Promise<EmailTemplateRow | null> {
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.key, key),
        eq(emailTemplates.isActive, true),
        inArray(emailTemplates.locale, [...locales]),
        eventId
          ? or(eq(emailTemplates.eventId, eventId), isNull(emailTemplates.eventId))
          : isNull(emailTemplates.eventId),
      ),
    );
  for (const locale of locales) {
    const forLocale = rows.filter((r) => r.locale === locale);
    const match =
      (eventId ? forLocale.find((r) => r.eventId === eventId) : undefined) ??
      forLocale.find((r) => r.eventId === null);
    if (match) return match;
  }
  return null;
}

export interface RenderEmailParams {
  key: EmailTemplateKey;
  orderId?: string | null;
  customerId?: string | null;
  eventId?: string | null;
  locale?: string | null;
  /** Recipient (exposed as {{recipientEmail}}). */
  to?: string | null;
  variables?: TemplateVariables;
  /** Attached invoices ({{invoiceNumber}}). */
  invoiceIds?: string[];
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Locale of the template actually used. */
  locale: string;
  templateId: string;
  /** Recipient derived from the order / customer when none was given. */
  to: string | null;
  /** Placeholders used by the template without a value. */
  missing: string[];
}

/** Renders a stored template with the standard variables (+ `variables` overrides). */
export async function renderEmail(
  ctx: CoreContext,
  params: RenderEmailParams,
): Promise<RenderedEmail> {
  const general = await getSetting(ctx, 'general');
  const data = params.orderId ? await loadOrderDocumentData(ctx.db, params.orderId) : null;
  if (params.orderId && !data) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  const customer =
    !data && params.customerId ? await customerVariables(ctx.db, params.customerId) : null;

  const requested =
    params.locale ?? data?.order.locale ?? customer?.locale ?? general.defaultLocale;
  const eventId = params.eventId ?? data?.events[0]?.id ?? null;
  const template = await resolveEmailTemplate(
    ctx.db,
    params.key,
    eventId,
    localeCandidates(requested, general.defaultLocale),
  );
  if (!template) {
    throw new EmailTemplateMissingError(`No active e-mail template "${params.key}"`);
  }

  const { variables: shop, shop: shopContext } = await shopVariables(ctx, template.locale);
  const to = params.to ?? data?.order.email ?? customer?.email ?? null;
  const variables: TemplateVariables = {
    ...shop,
    recipientEmail: to,
    ...(customer?.variables ?? {}),
    ...(data
      ? await orderVariables(ctx, data, shopContext, { invoiceIds: params.invoiceIds })
      : {}),
    ...(params.variables ?? {}),
  };

  const subject = renderTemplate(template.subject, variables, 'text');
  const html = renderTemplate(template.bodyHtml, variables, 'html');
  const text = template.bodyText
    ? renderTemplate(template.bodyText, variables, 'text')
    : { output: htmlToText(html.output), missing: [] };
  return {
    // One line; non-breaking spaces (e.g. in "32,10 €") are kept.
    subject: subject.output.replace(/[ \t\r\n]+/g, ' ').trim(),
    html: html.output,
    text: text.output.trim(),
    locale: template.locale,
    templateId: template.id,
    to,
    missing: [...new Set([...subject.missing, ...html.missing, ...text.missing])],
  };
}
