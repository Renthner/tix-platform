import { emailTemplateVariables, type EmailTemplateKey } from '@tix/shared';
import type { CoreContext } from '../context';
import { sanitizeEmailHtml } from './sanitize';
import {
  TemplateSyntaxError,
  type TemplateSyntaxCode,
  escapeHtml,
  htmlToText,
  parseTemplate,
  renderTemplate,
  templatePlaceholders,
  trustedHtml,
  type TemplateVariables,
} from './template';
import { shopVariables } from './variables';

/** Admin-facing checks of a template before it is saved, and sample rendering for previews. */

export type TemplateField = 'subject' | 'bodyHtml' | 'bodyText';

export interface TemplateIssue {
  field: TemplateField;
  /** `syntax`: unbalanced / malformed sections (blocks saving); `unknownPlaceholder`: warning. */
  code: 'syntax' | 'unknownPlaceholder' | 'unavailablePlaceholder';
  /** Offending placeholder (unknown*) or the parser's message (syntax). */
  detail: string;
  /** Translatable form of a `syntax` issue (stable code + params). */
  syntax?: { code: TemplateSyntaxCode; params: Record<string, string | number> };
}

export interface TemplateValidation {
  errors: TemplateIssue[];
  warnings: TemplateIssue[];
}

export interface TemplateDraft {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
}

/** Variables that can be used in templates of `key` (names only). */
export function allowedPlaceholders(key: EmailTemplateKey): Set<string> {
  return new Set(emailTemplateVariables(key).map((v) => v.name));
}

/**
 * Syntax errors (unbalanced `{{#if}}`, stray `{{else}}`, empty placeholders) block saving;
 * placeholders the template key does not provide are warnings (they render empty).
 */
export function validateEmailTemplate(
  key: EmailTemplateKey,
  draft: TemplateDraft,
): TemplateValidation {
  const allowed = allowedPlaceholders(key);
  const errors: TemplateIssue[] = [];
  const warnings: TemplateIssue[] = [];
  const fields: [TemplateField, string][] = [
    ['subject', draft.subject],
    ['bodyHtml', draft.bodyHtml],
    ['bodyText', draft.bodyText ?? ''],
  ];
  for (const [field, source] of fields) {
    try {
      parseTemplate(source);
    } catch (err) {
      if (!(err instanceof TemplateSyntaxError)) throw err;
      errors.push({
        field,
        code: 'syntax',
        detail: err.message,
        syntax: { code: err.code, params: err.params },
      });
      continue;
    }
    for (const name of templatePlaceholders(source)) {
      if (!allowed.has(name)) warnings.push({ field, code: 'unknownPlaceholder', detail: name });
    }
  }
  return { errors, warnings };
}

/**
 * Sanitises the HTML body and validates the result (sanitising must not break sections, so
 * the sanitised document is what gets checked).
 */
export function prepareEmailTemplate(
  key: EmailTemplateKey,
  draft: TemplateDraft,
  options: { baseUrl?: string | null } = {},
): { draft: TemplateDraft; validation: TemplateValidation } {
  const clean: TemplateDraft = {
    subject: draft.subject.replace(/[\r\n]+/g, ' ').trim(),
    bodyHtml: sanitizeEmailHtml(draft.bodyHtml, options),
    bodyText: draft.bodyText?.trim() ? draft.bodyText.replace(/\r\n/g, '\n').trim() : null,
  };
  return { draft: clean, validation: validateEmailTemplate(key, clean) };
}

// ─── Sample data ────────────────────────────────────────────────────────────

const SAMPLE = {
  en: {
    firstName: 'Alex',
    lastName: 'Sample',
    eventTitle: 'Example Musical',
    eventVenue: 'Town Hall, Sampletown',
    eventDate: 'Sat, 14 March 2026, 7:30 PM',
    orderDate: '1 March 2026',
    paymentMethod: 'Bank transfer',
    status: 'PENDING_PAYMENT',
    seat: 'Stalls A · Row 4 · Seat 12',
    seat2: 'Stalls A · Row 4 · Seat 13',
    doors: 'Doors open 6:30 PM',
    total: 'Total',
    reason: 'Payment not received in time',
    holder: 'Sample Club e.V.',
    wallet: 'Add to wallet',
    downloadPdf: 'Download PDF',
  },
  de: {
    firstName: 'Alex',
    lastName: 'Muster',
    eventTitle: 'Beispiel-Musical',
    eventVenue: 'Stadthalle, Musterstadt',
    eventDate: 'Sa., 14. März 2026, 19:30 Uhr',
    orderDate: '01.03.2026',
    paymentMethod: 'Vorkasse (Überweisung)',
    status: 'PENDING_PAYMENT',
    seat: 'Parkett A · Reihe 4 · Platz 12',
    seat2: 'Parkett A · Reihe 4 · Platz 13',
    doors: 'Einlass ab 18:30 Uhr',
    total: 'Gesamt',
    reason: 'Zahlung nicht rechtzeitig eingegangen',
    holder: 'Musterverein e.V.',
    wallet: 'Zur Wallet hinzufügen',
    downloadPdf: 'PDF herunterladen',
  },
} as const;

const CELL = 'padding:6px 0;border-top:1px solid #e4e4e7;vertical-align:top';

/**
 * Plausible values for every variable a template key provides. `shop` carries the real shop
 * variables (colours, organizer, …); order and account values are invented.
 */
export function sampleEmailVariables(
  key: EmailTemplateKey,
  locale: string,
  shop: TemplateVariables,
  options: { orderUrl?: string; recipient?: string } = {},
): TemplateVariables {
  const s = locale === 'de' ? SAMPLE.de : SAMPLE.en;
  const base = options.orderUrl ?? 'https://shop.example.org';
  const eventLine = `${s.eventDate} · ${s.eventVenue}`;
  const itemsHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;line-height:1.45"><tr><td colspan="2" style="padding:14px 0 2px;font-weight:600;font-size:15px">${escapeHtml(s.eventTitle)}</td></tr><tr><td colspan="2" style="padding:0 0 6px;color:#52525b;font-size:13px">${escapeHtml(`${eventLine} · ${s.doors}`)}</td></tr><tr><td style="${CELL}">${escapeHtml(s.seat)}<br><span style="color:#52525b;font-size:13px">Category 1</span></td><td align="right" style="${CELL};white-space:nowrap">24,00 €</td></tr><tr><td style="${CELL}">${escapeHtml(s.seat2)}<br><span style="color:#52525b;font-size:13px">Category 1</span></td><td align="right" style="${CELL};white-space:nowrap">24,00 €</td></tr><tr><td style="padding:10px 0;border-top:2px solid #18181b;font-weight:700">${escapeHtml(s.total)}</td><td align="right" style="padding:10px 0;border-top:2px solid #18181b;font-weight:700;white-space:nowrap">48,00 €</td></tr></table>`;
  const itemsText = `${s.eventTitle}\n${eventLine} · ${s.doors}\n  - ${s.seat}: 24,00 €\n  - ${s.seat2}: 24,00 €\n${s.total}: 48,00 €`;
  const eventListHtml = `<ul style="margin:0;padding:0 0 0 18px"><li style="margin:0 0 8px"><strong>${escapeHtml(s.eventTitle)}</strong><br><span style="color:#52525b">${escapeHtml(eventLine)}</span></li></ul>`;
  const walletHtml = `<p style="margin:0 0 16px"><a href="https://wallet.example.org/pass" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">${escapeHtml(s.wallet)}</a></p>`;

  const ticketButton = (label: string, url: string) =>
    `<a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;margin:0 8px 8px 0">${escapeHtml(label)}</a>`;
  const ticketLinksHtml = [s.seat, s.seat2]
    .map(
      (place, i) =>
        `<p style="margin:0 0 4px;font-size:13px;color:#52525b">${escapeHtml(place)} · SAMPLE-${i + 1}</p><p style="margin:0 0 14px">${ticketButton(s.downloadPdf, `${base}/api/orders/sample/tickets/sample-${i + 1}?t=sample-token`)}${ticketButton(s.wallet, 'https://wallet.example.org/pass')}</p>`,
    )
    .join('');
  const ticketLinksText = [s.seat, s.seat2]
    .map(
      (place, i) =>
        `${place} (SAMPLE-${i + 1})\n${s.downloadPdf}: ${base}/api/orders/sample/tickets/sample-${i + 1}?t=sample-token\n${s.wallet}: https://wallet.example.org/pass`,
    )
    .join('\n\n');

  const paid = key === 'PAYMENT_RECEIVED_TICKETS' || key === 'TICKETS_RESENT';
  const variables: TemplateVariables = {
    ...shop,
    recipientEmail: options.recipient ?? 'alex.sample@example.org',
    firstName: s.firstName,
    lastName: s.lastName,
    fullName: `${s.firstName} ${s.lastName}`,
    email: options.recipient ?? 'alex.sample@example.org',
    company: null,
    orderNumber: '2026-000123',
    orderDate: s.orderDate,
    orderStatus: paid ? 'PAID' : s.status,
    amount: '48,00 €',
    amountPaid: paid ? '48,00 €' : '0,00 €',
    amountDue: paid ? '0,00 €' : '48,00 €',
    currency: 'EUR',
    paymentMethod: s.paymentMethod,
    paymentReference: 'TIX-2026-123456-7',
    paymentDueDate: locale === 'de' ? '12.03.2026' : '12 March 2026',
    autoCancelDate: locale === 'de' ? '16.03.2026' : '16 March 2026',
    bankAccountHolder: s.holder,
    iban: 'DE02 1203 0000 0000 2020 51',
    bic: 'BYLADEM1001',
    bankName: 'Sample Bank',
    orderUrl: `${base}/orders/sample-token`,
    eventTitle: s.eventTitle,
    eventDate: s.eventDate,
    eventVenue: s.eventVenue,
    eventList: trustedHtml(eventListHtml, `- ${s.eventTitle}\n  ${eventLine}`),
    itemsTable: trustedHtml(itemsHtml, itemsText),
    ticketCount: 2,
    reminderCount: 1,
    cancellationReason: s.reason,
    invoiceNumber: 'RE-2026-000045',
    walletLinks: trustedHtml(walletHtml, `${s.wallet}: https://wallet.example.org/pass`),
    ticketLinks: trustedHtml(ticketLinksHtml, ticketLinksText),
    ticketsAttached: 'yes',
    ticketsPdfUrl: `${base}/api/orders/sample/tickets?t=sample-token`,
    verificationUrl: `${base}/account/verify?token=sample`,
    resetUrl: `${base}/account/reset?token=sample`,
    loginUrl: `${base}/account/login-link?token=sample`,
    expiresAt: locale === 'de' ? '01.03.2026, 18:00 Uhr' : '1 March 2026, 6:00 PM',
    sentAt: locale === 'de' ? '01.03.2026, 12:00 Uhr' : '1 March 2026, 12:00 PM',
  };
  return variables;
}

export interface RenderedPreview {
  subject: string;
  html: string;
  text: string;
  /** Used placeholders the sample data does not know. */
  missing: string[];
}

/** Renders a draft exactly like the delivery pipeline does, with sample variables. */
export function renderTemplateDraft(
  draft: TemplateDraft,
  variables: TemplateVariables,
): RenderedPreview {
  const subject = renderTemplate(draft.subject, variables, 'text');
  const html = renderTemplate(draft.bodyHtml, variables, 'html');
  const text = draft.bodyText
    ? renderTemplate(draft.bodyText, variables, 'text')
    : { output: htmlToText(html.output), missing: [] as string[] };
  return {
    subject: subject.output.replace(/[ \t\r\n]+/g, ' ').trim(),
    html: html.output,
    text: text.output.trim(),
    missing: [...new Set([...subject.missing, ...html.missing, ...text.missing])],
  };
}

/** Sanitises and previews an unsaved draft with the real shop variables and sample orders. */
export async function previewEmailTemplate(
  ctx: CoreContext,
  key: EmailTemplateKey,
  locale: string,
  draft: TemplateDraft,
): Promise<RenderedPreview & { validation: TemplateValidation; plainTextGenerated: boolean }> {
  const { draft: clean, validation } = prepareEmailTemplate(key, draft, {
    baseUrl: ctx.appUrl ?? null,
  });
  if (validation.errors.length > 0) {
    return {
      subject: clean.subject,
      html: '',
      text: '',
      missing: [],
      validation,
      plainTextGenerated: clean.bodyText === null,
    };
  }
  const { variables: shop } = await shopVariables(ctx, locale);
  const variables = sampleEmailVariables(key, locale, shop, {
    orderUrl: ctx.appUrl ?? undefined,
  });
  return {
    ...renderTemplateDraft(clean, variables),
    validation,
    plainTextGenerated: clean.bodyText === null,
  };
}
