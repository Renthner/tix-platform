import type { EmailTemplateKey } from './enums';

/**
 * Pure helpers of the e-mail template editor, shared by the server (validation, preview) and
 * the browser (placeholder picker, visual editor): which variables a template can use, and
 * how to find the editable content region inside a full HTML e-mail document.
 */

export type EmailVariableGroup =
  'shop' | 'customer' | 'order' | 'adjustment' | 'tickets' | 'account' | 'smtpTest';

export interface EmailVariableInfo {
  name: string;
  group: EmailVariableGroup;
  /** `html`: generated markup inserted as-is (never escaped), e.g. `{{itemsTable}}`. */
  kind: 'text' | 'html';
}

const names = (
  group: EmailVariableGroup,
  list: readonly string[],
  kind: 'text' | 'html' = 'text',
) => list.map((name): EmailVariableInfo => ({ name, group, kind }));

const SHOP = names('shop', [
  'shopName',
  'shopUrl',
  'supportEmail',
  'brandColor',
  'brandForegroundColor',
  'primaryColor',
  'accentColor',
  'imprintUrl',
  'privacyUrl',
  'termsUrl',
  'organizerName',
  'organizerAddress',
  'organizerEmail',
  'organizerPhone',
  'organizerWebsite',
  'organizerVatId',
  'recipientEmail',
]);

const CUSTOMER = names('customer', ['firstName', 'lastName', 'fullName', 'email']);

const ORDER = [
  ...names('order', [
    'firstName',
    'lastName',
    'fullName',
    'email',
    'company',
    'orderNumber',
    'orderDate',
    'orderStatus',
    'amount',
    'amountPaid',
    'amountDue',
    'currency',
    'paymentMethod',
    'paymentReference',
    'paymentDueDate',
    'autoCancelDate',
    'bankAccountHolder',
    'iban',
    'bic',
    'bankName',
    'orderUrl',
    'eventTitle',
    'eventDate',
    'eventVenue',
    'ticketCount',
    'reminderCount',
    'cancellationReason',
    'invoiceNumber',
  ]),
  ...names('order', ['eventList', 'itemsTable'], 'html'),
];

const ADJUSTMENT = [
  ...names('adjustment', [
    'adjustmentAmount',
    'adjustmentCreditUsed',
    'adjustmentReference',
    'adjustmentReason',
  ]),
  ...names('adjustment', ['adjustmentItems'], 'html'),
];

/** ADDITIONAL_PAYMENT_RECEIVED: the corrected documents and what was paid before / now. */
const ADJUSTMENT_PAID = [
  ...ADJUSTMENT,
  ...names('adjustment', [
    'adjustmentNewTotal',
    'adjustmentPreviouslyPaid',
    'adjustmentOldInvoiceNumber',
    'adjustmentNewInvoiceNumber',
    'adjustmentCreditNoteNumber',
  ]),
];

const WALLET = [
  ...names('tickets', ['walletLinks', 'ticketLinks'], 'html'),
  ...names('tickets', ['ticketsPdfUrl', 'ticketsAttached']),
];
const account = (url: string) => [
  ...names('customer', ['firstName']),
  ...names('account', [url, 'expiresAt']),
];

const BY_KEY: Record<EmailTemplateKey, readonly EmailVariableInfo[]> = {
  ORDER_CONFIRMATION_BANK_TRANSFER: [...SHOP, ...ORDER],
  PAYMENT_RECEIVED_TICKETS: [...SHOP, ...ORDER, ...WALLET],
  PAYMENT_REMINDER: [...SHOP, ...ORDER],
  ORDER_CANCELLED: [...SHOP, ...ORDER],
  REFUND_CONFIRMATION: [
    ...SHOP,
    ...ORDER,
    ...names('order', ['refundAmount', 'creditNoteNumber', 'refundViaPaypal', 'refundManual']),
  ],
  ADDITIONAL_PAYMENT_REQUEST: [...SHOP, ...ORDER, ...ADJUSTMENT],
  ADDITIONAL_PAYMENT_REMINDER: [...SHOP, ...ORDER, ...ADJUSTMENT],
  ADDITIONAL_PAYMENT_CANCELLED: [...SHOP, ...ORDER, ...ADJUSTMENT],
  ADDITIONAL_PAYMENT_RECEIVED: [...SHOP, ...ORDER, ...ADJUSTMENT_PAID, ...WALLET],
  ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT: [...SHOP, ...ORDER, ...ADJUSTMENT_PAID, ...WALLET],
  TICKETS_RESENT: [...SHOP, ...ORDER, ...WALLET],
  CUSTOMER_EMAIL_VERIFICATION: [...SHOP, ...CUSTOMER, ...account('verificationUrl')],
  CUSTOMER_PASSWORD_RESET: [...SHOP, ...CUSTOMER, ...account('resetUrl')],
  CUSTOMER_LOGIN_LINK: [...SHOP, ...CUSTOMER, ...account('loginUrl')],
  SMTP_TEST: [...SHOP, ...names('smtpTest', ['sentAt'])],
  ADMIN_INVITE: [...SHOP, ...account('inviteUrl')],
  ADMIN_PASSWORD_RESET: [...SHOP, ...account('resetUrl')],
};

/** Variables a template of this key can use (de-duplicated, in display order). */
export function emailTemplateVariables(key: EmailTemplateKey): EmailVariableInfo[] {
  const seen = new Set<string>();
  return BY_KEY[key].filter((v) => (seen.has(v.name) ? false : (seen.add(v.name), true)));
}

/** Snippets of the template language offered next to the placeholder picker. */
export const EMAIL_HELPER_SNIPPETS = [
  { id: 'if', snippet: '{{#if name}}…{{/if}}' },
  { id: 'ifElse', snippet: '{{#if name}}…{{else}}…{{/if}}' },
  { id: 'unless', snippet: '{{#unless name}}…{{/unless}}' },
] as const;

// ─── Content region ─────────────────────────────────────────────────────────

export const EMAIL_CONTENT_START = '<!--tix:content-->';
export const EMAIL_CONTENT_END = '<!--/tix:content-->';

/** The content cell of the default layout (before the editor ever added markers). */
const LEGACY_REGION =
  /(<td\b[^>]*style="[^"]*padding:\s*28px[^"]*"[^>]*>\s*)([\s\S]*?)(\s*<\/td>\s*<\/tr>\s*<tr>\s*<td\b[^>]*border-top)/i;

export interface EmailContentParts {
  before: string;
  content: string;
  after: string;
  /** How the region was found. */
  via: 'marker' | 'layout' | 'fragment';
}

/**
 * Splits an e-mail document into the part the visual editor edits (the message card's
 * content) and the surrounding layout shell. Returns null when the document has a custom
 * structure without a recognisable content region (then only the HTML source is editable).
 */
export function splitEmailContent(html: string): EmailContentParts | null {
  const start = html.indexOf(EMAIL_CONTENT_START);
  const end = html.indexOf(EMAIL_CONTENT_END);
  if (start !== -1 && end > start) {
    return {
      before: html.slice(0, start),
      content: html.slice(start + EMAIL_CONTENT_START.length, end),
      after: html.slice(end + EMAIL_CONTENT_END.length),
      via: 'marker',
    };
  }
  const legacy = LEGACY_REGION.exec(html);
  if (legacy) {
    const index = legacy.index + legacy[1]!.length;
    return {
      before: html.slice(0, index),
      content: legacy[2]!,
      after: html.slice(index + legacy[2]!.length),
      via: 'layout',
    };
  }
  if (!/<(html|body|table)\b/i.test(html)) {
    return { before: '', content: html, after: '', via: 'fragment' };
  }
  return null;
}

/** Puts edited content back into its shell; the region is marked for robust later splits. */
export function joinEmailContent(parts: EmailContentParts, content: string): string {
  if (parts.via === 'fragment') return content;
  return `${parts.before}${EMAIL_CONTENT_START}${content}${EMAIL_CONTENT_END}${parts.after}`;
}

// ─── Template logic in the visual editor ───────────────────────────────────

/**
 * `{{#if …}}`, `{{else}}`, `{{/if}}` (and `unless`) lines between blocks – and generated block
 * placeholders such as `{{itemsTable}}` – cannot be represented by a rich-text editor, and a
 * table row cannot hold loose text. The visual editor therefore shows them as non-editable
 * "logic chips": `protectEmailLogic` turns them into `<div data-tpl="…"></div>` before the
 * editor loads the content, `restoreEmailLogic` turns the chips back into the template text.
 * Directives inside running text (`Hello{{#if firstName}} {{firstName}}{{/if}},`) stay plain
 * text; only tokens at block level are protected.
 */

const LOGIC_TOKEN = /\{\{\s*(?:#if\b|#unless\b|else\b|\/if\b|\/unless\b)[^{}]*\}\}/g;
/** Block-level placeholders: only protected when they stand alone between blocks. */
const BLOCK_VARIABLE =
  /\{\{\s*(?:itemsTable|eventList|walletLinks|ticketLinks|adjustmentItems)\s*\}\}/g;
const TOKEN = new RegExp(`${LOGIC_TOKEN.source}|${BLOCK_VARIABLE.source}`, 'g');

const BLOCK_TAGS = 'p|table|h[1-6]|ul|ol|blockquote|div|hr';
/** What may precede a block-level token: nothing, a closing block tag or a cell/div opening. */
const BEFORE_BLOCK = new RegExp(
  String.raw`(?:^|</(?:${BLOCK_TAGS}|td|th)>|<(?:td|th|div)\b[^>]*>)\s*$`,
  'i',
);
/** What may follow it: nothing, an opening block tag or a closing cell/div. */
const AFTER_BLOCK = new RegExp(String.raw`^\s*(?:$|<(?:${BLOCK_TAGS})\b|</(?:td|th|div)>)`, 'i');

const escapeAttr = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeAttr = (v: string) =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

export function protectEmailLogic(html: string): string {
  let out = '';
  let last = 0;
  // Tokens decided "block" so far; a block token also counts as a block boundary for the next.
  const matches = [...html.matchAll(TOKEN)];
  let prevBlockEnd = -1;
  for (const m of matches) {
    const start = m.index!;
    const end = start + m[0].length;
    const beforeText = html.slice(0, start);
    const afterText = html.slice(end);
    const beforeOk =
      (prevBlockEnd >= 0 && /^\s*$/.test(html.slice(prevBlockEnd, start))) ||
      BEFORE_BLOCK.test(beforeText.slice(-400));
    const afterOk =
      AFTER_BLOCK.test(afterText.slice(0, 400)) || nextTokenStartsAt(matches, end, html);
    if (beforeOk && afterOk) {
      out += html.slice(last, start) + `<div data-tpl="${escapeAttr(m[0])}"></div>`;
      last = end;
      prevBlockEnd = end;
    }
  }
  return out + html.slice(last);
}

/** True when the next token follows directly (only whitespace between) – chips chain up. */
function nextTokenStartsAt(matches: RegExpMatchArray[], end: number, html: string): boolean {
  const next = matches.find((m) => m.index! >= end);
  if (!next) return false;
  return /^\s*$/.test(html.slice(end, next.index!));
}

/**
 * Inverse of `protectEmailLogic`: chips back to template text, and the raw `style` strings
 * (`data-tpl-style`) back in place of the browser-normalised ones (applied to editor output).
 */
export function restoreEmailLogic(html: string): string {
  return html
    .replace(/<div\b[^>]*\bdata-tpl="([^"]*)"[^>]*>(?:[^<]*)<\/div>/g, (_m, code: string) =>
      unescapeAttr(code),
    )
    .replace(/<[a-z][^<>]*\bdata-tpl-style="[^"]*"[^<>]*>/gi, (tag) => {
      const raw = /\bdata-tpl-style="([^"]*)"/.exec(tag)![1]!;
      return tag
        .replace(/\sdata-tpl-style="[^"]*"/, '')
        .replace(/\sstyle="[^"]*"/, '')
        .replace(/^(<[a-z0-9]+)/i, `$1 style="${raw}"`);
    });
}
