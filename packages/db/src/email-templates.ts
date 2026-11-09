import { EMAIL_TEMPLATE_KEYS, type EmailTemplateKey } from '@tix/shared';

/**
 * Default transactional e-mail templates (English + German), seeded into `email_templates`
 * once per key/locale and from then on edited in the Admin Portal – the seed never
 * overwrites edited rows (unedited rows of an earlier default are upgraded, see
 * `email-template-history.ts`). Placeholders: `{{name}}` (escaped), `{{#if name}}…{{else}}…{{/if}}`,
 * `{{#unless name}}…{{/unless}}`; `{{itemsTable}}` / `{{eventList}}` are generated HTML.
 * Texts are brand-neutral: shop, organizer and bank data come from the settings.
 */

export interface DefaultEmailTemplate {
  key: EmailTemplateKey;
  locale: 'en' | 'de';
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

type Locale = DefaultEmailTemplate['locale'];

interface Content {
  subject: string;
  /** Inner HTML of the message card. */
  html: string;
  /** Plain-text body (footer appended automatically). */
  text: string;
}

const COMMON = {
  en: {
    hello: 'Hello{{#if firstName}} {{firstName}}{{/if}},',
    regards: 'Kind regards,<br>your {{shopName}} team',
    regardsText: 'Kind regards,\nyour {{shopName}} team',
    viewOrder: 'View your order',
    buttonFallback: 'If the button does not work, copy this link into your browser:',
    questions: 'Questions? Simply reply to this e-mail',
    questionsWrite: 'or write to',
    imprint: 'Imprint',
    privacy: 'Privacy policy',
    holder: 'Account holder',
    bank: 'Bank',
    amount: 'Amount',
    reference: 'Payment reference',
    due: 'Due date',
    noBank: 'We will send you the bank details for your transfer separately.',
  },
  de: {
    hello: 'Hallo{{#if firstName}} {{firstName}}{{/if}},',
    regards: 'Herzliche Grüße<br>dein Team von {{shopName}}',
    regardsText: 'Herzliche Grüße\ndein Team von {{shopName}}',
    viewOrder: 'Bestellung ansehen',
    buttonFallback:
      'Falls der Button nicht funktioniert, kopiere bitte diesen Link in deinen Browser:',
    questions: 'Fragen? Antworte einfach auf diese E-Mail',
    questionsWrite: 'oder schreib an',
    imprint: 'Impressum',
    privacy: 'Datenschutz',
    holder: 'Kontoinhaber',
    bank: 'Bank',
    amount: 'Betrag',
    reference: 'Verwendungszweck',
    due: 'Zahlbar bis',
    noBank: 'Die Bankverbindung für deine Überweisung senden wir dir gesondert zu.',
  },
} as const;

const P = 'margin:0 0 16px';
const MUTED = 'color:#52525b';

const paragraph = (html: string) => `<p style="${P}">${html}</p>`;

function button(locale: Locale, urlVar: string, label: string): string {
  return `{{#if ${urlVar}}}<p style="margin:24px 0">
  <a href="{{${urlVar}}}" style="display:inline-block;background:{{accentColor}};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">${label}</a>
</p>
<p style="margin:0 0 16px;font-size:12px;${MUTED}">${COMMON[locale].buttonFallback}<br><a href="{{${urlVar}}}" style="color:#52525b;word-break:break-all">{{${urlVar}}}</a></p>{{/if}}`;
}

const TICKET_TEXT = {
  en: {
    individually: 'Your tickets:',
    all: 'All tickets in one PDF',
  },
  de: {
    individually: 'Deine Tickets einzeln:',
    all: 'Alle Tickets in einem PDF',
  },
} as const;

/**
 * Per-ticket downloads: `{{ticketLinks}}` is generated HTML (caption + PDF / wallet buttons per
 * valid ticket, empty without appUrl or tickets); `ticketsPdfUrl` the combined PDF as a small
 * secondary link. The `{{#if}}` sits between block elements.
 */
function ticketLinksBlock(locale: Locale): string {
  const c = TICKET_TEXT[locale];
  return `{{#if ticketLinks}}${paragraph(c.individually)}
{{ticketLinks}}{{/if}}{{#if ticketsPdfUrl}}<p style="margin:0 0 16px;font-size:13px"><a href="{{ticketsPdfUrl}}" style="color:#52525b">${c.all}</a></p>{{/if}}`;
}

function ticketLinksText(locale: Locale): string {
  const c = TICKET_TEXT[locale];
  return `{{#if ticketLinks}}${c.individually}
{{ticketLinks}}

{{/if}}{{#if ticketsPdfUrl}}${c.all}: {{ticketsPdfUrl}}

{{/if}}`;
}

/** Attachment sentence, or – when the PDF had to be left out (mail too large) – the download hint. */
const ticketsSentence = (attached: string, download: string) =>
  `{{#if ticketsAttached}}${attached}{{else}}${download}{{/if}}`;

/**
 * Bank details as a stacked list (small grey label, bold value underneath) inside one grey box.
 * No side-by-side columns, so nothing is squeezed on phones, and every `{{#if}}` sits between
 * paragraphs (never inside table rows) – which keeps the visual editor able to show it.
 */
function bankDetails(locale: Locale): { html: string; text: string } {
  const c = COMMON[locale];
  const MONO = 'font-family:Consolas,Menlo,Monaco,monospace';
  const label = (text: string) =>
    `<p style="margin:0;font-size:12px;line-height:1.4;color:#71717a">${text}</p>`;
  const value = (inner: string, style = '') =>
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.4;word-break:break-word${style}">${inner}</p>`;
  const detail = (text: string, inner: string, style = '') => `${label(text)}
${value(inner, style)}`;
  const html = `{{#if iban}}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;border-radius:6px;margin:0 0 16px">
<tr><td style="padding:14px 16px 2px">
${detail(c.holder, '<strong>{{bankAccountHolder}}</strong>')}
${detail('IBAN', '<strong>{{iban}}</strong>', `;${MONO};font-size:16px;letter-spacing:0.5px`)}
{{#if bic}}${detail('BIC', '{{bic}}')}{{/if}}
{{#if bankName}}${detail(c.bank, '{{bankName}}')}{{/if}}
${detail(c.amount, '<strong>{{amountDue}}</strong>')}
${detail(c.reference, '<strong>{{paymentReference}}</strong>', `;${MONO};font-size:18px`)}
{{#if paymentDueDate}}${detail(c.due, '<strong>{{paymentDueDate}}</strong>')}{{/if}}
</td></tr>
</table>{{else}}${paragraph(c.noBank)}{{/if}}`;
  const text = `{{#if iban}}${c.holder}: {{bankAccountHolder}}
IBAN: {{iban}}
{{#if bic}}BIC: {{bic}}
{{/if}}{{#if bankName}}${c.bank}: {{bankName}}
{{/if}}${c.amount}: {{amountDue}}
${c.reference}: {{paymentReference}}
{{#if paymentDueDate}}${c.due}: {{paymentDueDate}}
{{/if}}{{else}}${c.noBank}
{{/if}}`;
  return { html, text };
}

function layout(locale: Locale, inner: string): string {
  const c = COMMON[locale];
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{{shopName}}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<tr><td style="background:{{primaryColor}};border-radius:8px 8px 0 0;padding:20px 28px;color:#ffffff;font-size:20px;font-weight:700">{{shopName}}</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">
${inner}
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.6;color:#71717a">
{{organizerName}}{{#if organizerAddress}} · {{organizerAddress}}{{/if}}<br>
${c.questions}{{#if supportEmail}} ${c.questionsWrite} <a href="mailto:{{supportEmail}}" style="color:#71717a">{{supportEmail}}</a>{{/if}}.
{{#if imprintUrl}}<br><a href="{{imprintUrl}}" style="color:#71717a">${c.imprint}</a>{{#if privacyUrl}} · <a href="{{privacyUrl}}" style="color:#71717a">${c.privacy}</a>{{/if}}{{else}}{{#if privacyUrl}}<br><a href="{{privacyUrl}}" style="color:#71717a">${c.privacy}</a>{{/if}}{{/if}}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

function textFooter(locale: Locale): string {
  const c = COMMON[locale];
  return `

--
{{organizerName}}{{#if organizerAddress}} · {{organizerAddress}}{{/if}}
${c.questions}{{#if supportEmail}} ${c.questionsWrite} {{supportEmail}}{{/if}}.
{{#if imprintUrl}}${c.imprint}: {{imprintUrl}}
{{/if}}{{#if privacyUrl}}${c.privacy}: {{privacyUrl}}
{{/if}}`;
}

const orderLink = (locale: Locale) =>
  `{{#if orderUrl}}${locale === 'de' ? 'Deine Bestellung' : 'Your order'}: {{orderUrl}}\n\n{{/if}}`;

const CONTENT: Record<EmailTemplateKey, Record<Locale, () => Content>> = {
  ORDER_CONFIRMATION_BANK_TRANSFER: {
    en: () => {
      const bank = bankDetails('en');
      return {
        subject: 'Your order {{orderNumber}} – please transfer {{amountDue}}',
        html: [
          paragraph(COMMON.en.hello),
          paragraph(
            'thank you for your order at {{shopName}}! Your seats are reserved for you. Please transfer the amount below{{#if paymentDueDate}} by <strong>{{paymentDueDate}}</strong>{{/if}} – as soon as your payment has arrived, we will confirm it and send you your tickets.{{#if autoCancelDate}} Unpaid orders are cancelled automatically on <strong>{{autoCancelDate}}</strong> and the seats are released.{{/if}}',
          ),
          bank.html,
          paragraph(
            '<strong>Important:</strong> please enter only <strong>{{paymentReference}}</strong> as the payment reference so that we can assign your transfer automatically.',
          ),
          `<h2 style="margin:24px 0 4px;font-size:16px">Order {{orderNumber}} of {{orderDate}}</h2>`,
          '{{itemsTable}}',
          button('en', 'orderUrl', COMMON.en.viewOrder),
          paragraph('We are looking forward to your visit!'),
          paragraph(COMMON.en.regards),
        ].join('\n'),
        text: `Hello{{#if firstName}} {{firstName}}{{/if}},

thank you for your order at {{shopName}}! Your seats are reserved for you. Please transfer the amount below{{#if paymentDueDate}} by {{paymentDueDate}}{{/if}} – as soon as your payment has arrived, we will confirm it and send you your tickets.{{#if autoCancelDate}} Unpaid orders are cancelled automatically on {{autoCancelDate}} and the seats are released.{{/if}}

${bank.text}
Important: please enter only {{paymentReference}} as the payment reference so that we can assign your transfer automatically.

Order {{orderNumber}} of {{orderDate}}

{{itemsTable}}

${orderLink('en')}We are looking forward to your visit!

${COMMON.en.regardsText}`,
      };
    },
    de: () => {
      const bank = bankDetails('de');
      return {
        subject: 'Deine Bestellung {{orderNumber}} – bitte überweise {{amountDue}}',
        html: [
          paragraph(COMMON.de.hello),
          paragraph(
            'vielen Dank für deine Bestellung bei {{shopName}}! Deine Plätze sind für dich reserviert. Bitte überweise den folgenden Betrag{{#if paymentDueDate}} bis zum <strong>{{paymentDueDate}}</strong>{{/if}} – sobald deine Zahlung eingegangen ist, bestätigen wir sie und senden dir deine Tickets.{{#if autoCancelDate}} Unbezahlte Bestellungen werden am <strong>{{autoCancelDate}}</strong> automatisch storniert und die Plätze freigegeben.{{/if}}',
          ),
          bank.html,
          paragraph(
            '<strong>Wichtig:</strong> Bitte gib als Verwendungszweck ausschließlich <strong>{{paymentReference}}</strong> an, damit wir deine Überweisung automatisch zuordnen können.',
          ),
          `<h2 style="margin:24px 0 4px;font-size:16px">Bestellung {{orderNumber}} vom {{orderDate}}</h2>`,
          '{{itemsTable}}',
          button('de', 'orderUrl', COMMON.de.viewOrder),
          paragraph('Wir freuen uns auf deinen Besuch!'),
          paragraph(COMMON.de.regards),
        ].join('\n'),
        text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

vielen Dank für deine Bestellung bei {{shopName}}! Deine Plätze sind für dich reserviert. Bitte überweise den folgenden Betrag{{#if paymentDueDate}} bis zum {{paymentDueDate}}{{/if}} – sobald deine Zahlung eingegangen ist, bestätigen wir sie und senden dir deine Tickets.{{#if autoCancelDate}} Unbezahlte Bestellungen werden am {{autoCancelDate}} automatisch storniert und die Plätze freigegeben.{{/if}}

${bank.text}
Wichtig: Bitte gib als Verwendungszweck ausschließlich {{paymentReference}} an, damit wir deine Überweisung automatisch zuordnen können.

Bestellung {{orderNumber}} vom {{orderDate}}

{{itemsTable}}

${orderLink('de')}Wir freuen uns auf deinen Besuch!

${COMMON.de.regardsText}`,
      };
    },
  },

  PAYMENT_RECEIVED_TICKETS: {
    en: () => ({
      subject: 'Payment received – your order {{orderNumber}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'we have received your payment of <strong>{{amount}}</strong> – thank you very much! Your order {{orderNumber}} is fully paid and your seats are confirmed.',
        ),
        '{{#if invoiceNumber}}' +
          paragraph('Your invoice {{invoiceNumber}} is attached to this e-mail.') +
          '{{/if}}',
        paragraph(
          ticketsSentence(
            'Your tickets are attached to this e-mail as PDF. You can also download them at any time on your order page.',
            'You can download your tickets individually below or at any time on your order page.',
          ),
        ),
        ticketLinksBlock('en'),
        '{{itemsTable}}',
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph('We are looking forward to seeing you!'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

we have received your payment of {{amount}} – thank you very much! Your order {{orderNumber}} is fully paid and your seats are confirmed.

{{#if invoiceNumber}}Your invoice {{invoiceNumber}} is attached to this e-mail.

{{/if}}${ticketsSentence('Your tickets are attached to this e-mail as PDF. You can also download them at any time on your order page.', 'You can download your tickets individually below or at any time on your order page.')}

${ticketLinksText('en')}{{itemsTable}}

${orderLink('en')}We are looking forward to seeing you!

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Zahlung erhalten – deine Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'wir haben deine Zahlung über <strong>{{amount}}</strong> erhalten – herzlichen Dank! Deine Bestellung {{orderNumber}} ist vollständig bezahlt und deine Plätze sind fest gebucht.',
        ),
        '{{#if invoiceNumber}}' +
          paragraph('Deine Rechnung {{invoiceNumber}} findest du im Anhang dieser E-Mail.') +
          '{{/if}}',
        paragraph(
          ticketsSentence(
            'Deine Tickets findest du als PDF im Anhang dieser E-Mail. Du kannst sie außerdem jederzeit auf der Seite deiner Bestellung herunterladen.',
            'Du kannst deine Tickets unten einzeln oder jederzeit auf der Seite deiner Bestellung herunterladen.',
          ),
        ),
        ticketLinksBlock('de'),
        '{{itemsTable}}',
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph('Wir freuen uns auf dich!'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

wir haben deine Zahlung über {{amount}} erhalten – herzlichen Dank! Deine Bestellung {{orderNumber}} ist vollständig bezahlt und deine Plätze sind fest gebucht.

{{#if invoiceNumber}}Deine Rechnung {{invoiceNumber}} findest du im Anhang dieser E-Mail.

{{/if}}${ticketsSentence('Deine Tickets findest du als PDF im Anhang dieser E-Mail. Du kannst sie außerdem jederzeit auf der Seite deiner Bestellung herunterladen.', 'Du kannst deine Tickets unten einzeln oder jederzeit auf der Seite deiner Bestellung herunterladen.')}

${ticketLinksText('de')}{{itemsTable}}

${orderLink('de')}Wir freuen uns auf dich!

${COMMON.de.regardsText}`,
    }),
  },

  PAYMENT_REMINDER: {
    en: () => {
      const bank = bankDetails('en');
      return {
        subject: 'Payment reminder for your order {{orderNumber}}',
        html: [
          paragraph(COMMON.en.hello),
          paragraph(
            'we are still holding your seats for order {{orderNumber}} of {{orderDate}}, but we have not yet been able to find your payment. If your transfer has crossed with this e-mail, please simply disregard it.',
          ),
          paragraph(
            'Otherwise, please transfer the outstanding amount as soon as possible so that your reservation is not lost.{{#if autoCancelDate}} Unpaid orders are cancelled automatically on <strong>{{autoCancelDate}}</strong> and the seats are released.{{/if}}',
          ),
          bank.html,
          paragraph(
            'Please enter only <strong>{{paymentReference}}</strong> as the payment reference so that we can assign your transfer automatically.',
          ),
          '{{itemsTable}}',
          button('en', 'orderUrl', COMMON.en.viewOrder),
          paragraph(COMMON.en.regards),
        ].join('\n'),
        text: `Hello{{#if firstName}} {{firstName}}{{/if}},

we are still holding your seats for order {{orderNumber}} of {{orderDate}}, but we have not yet been able to find your payment. If your transfer has crossed with this e-mail, please simply disregard it.

Otherwise, please transfer the outstanding amount as soon as possible so that your reservation is not lost.{{#if autoCancelDate}} Unpaid orders are cancelled automatically on {{autoCancelDate}} and the seats are released.{{/if}}

${bank.text}
Please enter only {{paymentReference}} as the payment reference so that we can assign your transfer automatically.

{{itemsTable}}

${orderLink('en')}${COMMON.en.regardsText}`,
      };
    },
    de: () => {
      const bank = bankDetails('de');
      return {
        subject: 'Zahlungserinnerung zu deiner Bestellung {{orderNumber}}',
        html: [
          paragraph(COMMON.de.hello),
          paragraph(
            'deine Plätze aus der Bestellung {{orderNumber}} vom {{orderDate}} halten wir weiterhin für dich bereit, konnten deine Zahlung aber noch nicht finden. Hat sich deine Überweisung mit dieser E-Mail überschnitten, betrachte sie bitte als gegenstandslos.',
          ),
          paragraph(
            'Andernfalls überweise den offenen Betrag bitte möglichst bald, damit deine Reservierung nicht verloren geht.{{#if autoCancelDate}} Unbezahlte Bestellungen werden am <strong>{{autoCancelDate}}</strong> automatisch storniert und die Plätze freigegeben.{{/if}}',
          ),
          bank.html,
          paragraph(
            'Bitte gib als Verwendungszweck ausschließlich <strong>{{paymentReference}}</strong> an, damit wir deine Überweisung automatisch zuordnen können.',
          ),
          '{{itemsTable}}',
          button('de', 'orderUrl', COMMON.de.viewOrder),
          paragraph(COMMON.de.regards),
        ].join('\n'),
        text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

deine Plätze aus der Bestellung {{orderNumber}} vom {{orderDate}} halten wir weiterhin für dich bereit, konnten deine Zahlung aber noch nicht finden. Hat sich deine Überweisung mit dieser E-Mail überschnitten, betrachte sie bitte als gegenstandslos.

Andernfalls überweise den offenen Betrag bitte möglichst bald, damit deine Reservierung nicht verloren geht.{{#if autoCancelDate}} Unbezahlte Bestellungen werden am {{autoCancelDate}} automatisch storniert und die Plätze freigegeben.{{/if}}

${bank.text}
Bitte gib als Verwendungszweck ausschließlich {{paymentReference}} an, damit wir deine Überweisung automatisch zuordnen können.

{{itemsTable}}

${orderLink('de')}${COMMON.de.regardsText}`,
      };
    },
  },

  ORDER_CANCELLED: {
    en: () => ({
      subject: 'Your order {{orderNumber}} has been cancelled',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'your order {{orderNumber}} of {{orderDate}} has been cancelled and the reserved seats have been released.',
        ),
        '{{#if cancellationReason}}' +
          paragraph(`<span style="${MUTED}">Reason:</span> {{cancellationReason}}`) +
          '{{/if}}',
        paragraph(
          'If you have already transferred money for this order, please get in touch with us – you will of course get it back.',
        ),
        '{{itemsTable}}',
        paragraph('We would be delighted to welcome you at one of our next events.'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

your order {{orderNumber}} of {{orderDate}} has been cancelled and the reserved seats have been released.

{{#if cancellationReason}}Reason: {{cancellationReason}}

{{/if}}If you have already transferred money for this order, please get in touch with us – you will of course get it back.

{{itemsTable}}

We would be delighted to welcome you at one of our next events.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Deine Bestellung {{orderNumber}} wurde storniert',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'deine Bestellung {{orderNumber}} vom {{orderDate}} wurde storniert und die reservierten Plätze wurden wieder freigegeben.',
        ),
        '{{#if cancellationReason}}' +
          paragraph(`<span style="${MUTED}">Grund:</span> {{cancellationReason}}`) +
          '{{/if}}',
        paragraph(
          'Falls du für diese Bestellung bereits Geld überwiesen hast, melde dich bitte bei uns – du bekommst es selbstverständlich zurück.',
        ),
        '{{itemsTable}}',
        paragraph(
          'Wir würden uns freuen, dich bei einer unserer nächsten Veranstaltungen begrüßen zu dürfen.',
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

deine Bestellung {{orderNumber}} vom {{orderDate}} wurde storniert und die reservierten Plätze wurden wieder freigegeben.

{{#if cancellationReason}}Grund: {{cancellationReason}}

{{/if}}Falls du für diese Bestellung bereits Geld überwiesen hast, melde dich bitte bei uns – du bekommst es selbstverständlich zurück.

{{itemsTable}}

Wir würden uns freuen, dich bei einer unserer nächsten Veranstaltungen begrüßen zu dürfen.

${COMMON.de.regardsText}`,
    }),
  },

  REFUND_CONFIRMATION: {
    en: () => ({
      subject: 'Refund for your order {{orderNumber}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          '{{#if refundAmount}}we have refunded <strong>{{refundAmount}}</strong>{{else}}we have issued a refund{{/if}} for your order {{orderNumber}}. The money will be returned via your original payment method ({{paymentMethod}}); depending on your bank, it may take a few days to appear on your account.',
        ),
        '{{#if creditNoteNumber}}' +
          paragraph('Your credit note {{creditNoteNumber}} is attached to this e-mail.') +
          '{{/if}}',
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

{{#if refundAmount}}we have refunded {{refundAmount}}{{else}}we have issued a refund{{/if}} for your order {{orderNumber}}. The money will be returned via your original payment method ({{paymentMethod}}); depending on your bank, it may take a few days to appear on your account.

{{#if creditNoteNumber}}Your credit note {{creditNoteNumber}} is attached to this e-mail.

{{/if}}${orderLink('en')}${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Erstattung zu deiner Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          '{{#if refundAmount}}wir haben dir <strong>{{refundAmount}}</strong> erstattet{{else}}wir haben eine Erstattung veranlasst{{/if}} (Bestellung {{orderNumber}}). Das Geld bekommst du über deine ursprüngliche Zahlungsart ({{paymentMethod}}) zurück; je nach Bank kann die Gutschrift einige Tage dauern.',
        ),
        '{{#if creditNoteNumber}}' +
          paragraph(
            'Deine Rechnungskorrektur {{creditNoteNumber}} findest du im Anhang dieser E-Mail.',
          ) +
          '{{/if}}',
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

{{#if refundAmount}}wir haben dir {{refundAmount}} erstattet{{else}}wir haben eine Erstattung veranlasst{{/if}} (Bestellung {{orderNumber}}). Das Geld bekommst du über deine ursprüngliche Zahlungsart ({{paymentMethod}}) zurück; je nach Bank kann die Gutschrift einige Tage dauern.

{{#if creditNoteNumber}}Deine Rechnungskorrektur {{creditNoteNumber}} findest du im Anhang dieser E-Mail.

{{/if}}${orderLink('de')}${COMMON.de.regardsText}`,
    }),
  },

  TICKETS_RESENT: {
    en: () => ({
      subject: 'Your tickets for order {{orderNumber}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'as requested, here are the details of your order {{orderNumber}} once again. ' +
            ticketsSentence(
              'Your tickets are attached to this e-mail as PDF and can also be downloaded at any time on your order page.',
              'You can download your tickets individually below or at any time on your order page.',
            ),
        ),
        ticketLinksBlock('en'),
        '{{itemsTable}}',
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph('We are looking forward to seeing you!'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

as requested, here are the details of your order {{orderNumber}} once again. {{#if ticketsAttached}}Your tickets are attached to this e-mail as PDF and can also be downloaded at any time on your order page.{{else}}You can download your tickets individually below or at any time on your order page.{{/if}}

${ticketLinksText('en')}{{itemsTable}}

${orderLink('en')}We are looking forward to seeing you!

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Deine Tickets zur Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'wie gewünscht senden wir dir die Angaben zu deiner Bestellung {{orderNumber}} noch einmal. ' +
            ticketsSentence(
              'Deine Tickets findest du als PDF im Anhang dieser E-Mail; du kannst sie außerdem jederzeit auf der Seite deiner Bestellung herunterladen.',
              'Du kannst deine Tickets unten einzeln oder jederzeit auf der Seite deiner Bestellung herunterladen.',
            ),
        ),
        ticketLinksBlock('de'),
        '{{itemsTable}}',
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph('Wir freuen uns auf dich!'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

wie gewünscht senden wir dir die Angaben zu deiner Bestellung {{orderNumber}} noch einmal. {{#if ticketsAttached}}Deine Tickets findest du als PDF im Anhang dieser E-Mail; du kannst sie außerdem jederzeit auf der Seite deiner Bestellung herunterladen.{{else}}Du kannst deine Tickets unten einzeln oder jederzeit auf der Seite deiner Bestellung herunterladen.{{/if}}

${ticketLinksText('de')}{{itemsTable}}

${orderLink('de')}Wir freuen uns auf dich!

${COMMON.de.regardsText}`,
    }),
  },

  CUSTOMER_EMAIL_VERIFICATION: {
    en: () => ({
      subject: 'Please confirm your e-mail address',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'thank you for creating a customer account at {{shopName}}. Please confirm your e-mail address – afterwards you will find all your orders in your account.',
        ),
        button('en', 'verificationUrl', 'Confirm e-mail address'),
        '{{#if expiresAt}}' +
          paragraph(`<span style="${MUTED}">The link is valid until {{expiresAt}}.</span>`) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">If you did not create an account, you can simply ignore this e-mail.</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

thank you for creating a customer account at {{shopName}}. Please confirm your e-mail address by opening the following link – afterwards you will find all your orders in your account:

{{verificationUrl}}

{{#if expiresAt}}The link is valid until {{expiresAt}}.
{{/if}}If you did not create an account, you can simply ignore this e-mail.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Bitte bestätige deine E-Mail-Adresse',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'vielen Dank, dass du ein Kundenkonto bei {{shopName}} angelegt hast. Bitte bestätige deine E-Mail-Adresse – danach findest du alle deine Bestellungen in deinem Konto.',
        ),
        button('de', 'verificationUrl', 'E-Mail-Adresse bestätigen'),
        '{{#if expiresAt}}' +
          paragraph(`<span style="${MUTED}">Der Link ist gültig bis {{expiresAt}}.</span>`) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">Falls du kein Konto angelegt hast, kannst du diese E-Mail einfach ignorieren.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

vielen Dank, dass du ein Kundenkonto bei {{shopName}} angelegt hast. Bitte bestätige deine E-Mail-Adresse über den folgenden Link – danach findest du alle deine Bestellungen in deinem Konto:

{{verificationUrl}}

{{#if expiresAt}}Der Link ist gültig bis {{expiresAt}}.
{{/if}}Falls du kein Konto angelegt hast, kannst du diese E-Mail einfach ignorieren.

${COMMON.de.regardsText}`,
    }),
  },

  CUSTOMER_PASSWORD_RESET: {
    en: () => ({
      subject: 'Reset your password for {{shopName}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'we have received a request to reset the password of your customer account. Click the button below to choose a new password.',
        ),
        button('en', 'resetUrl', 'Choose a new password'),
        '{{#if expiresAt}}' +
          paragraph(
            `<span style="${MUTED}">The link is valid until {{expiresAt}} and can only be used once.</span>`,
          ) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">If you did not request this, you can ignore this e-mail – your password remains unchanged.</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

we have received a request to reset the password of your customer account. Open the following link to choose a new password:

{{resetUrl}}

{{#if expiresAt}}The link is valid until {{expiresAt}} and can only be used once.
{{/if}}If you did not request this, you can ignore this e-mail – your password remains unchanged.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Passwort zurücksetzen für {{shopName}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'wir haben eine Anfrage erhalten, das Passwort deines Kundenkontos zurückzusetzen. Über den Button unten kannst du ein neues Passwort festlegen.',
        ),
        button('de', 'resetUrl', 'Neues Passwort festlegen'),
        '{{#if expiresAt}}' +
          paragraph(
            `<span style="${MUTED}">Der Link ist gültig bis {{expiresAt}} und kann nur einmal verwendet werden.</span>`,
          ) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

wir haben eine Anfrage erhalten, das Passwort deines Kundenkontos zurückzusetzen. Über den folgenden Link kannst du ein neues Passwort festlegen:

{{resetUrl}}

{{#if expiresAt}}Der Link ist gültig bis {{expiresAt}} und kann nur einmal verwendet werden.
{{/if}}Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.

${COMMON.de.regardsText}`,
    }),
  },

  CUSTOMER_LOGIN_LINK: {
    en: () => ({
      subject: 'Your sign-in link for {{shopName}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'here is your personal link to sign in to your customer account – no password needed.',
        ),
        button('en', 'loginUrl', 'Sign in'),
        paragraph(
          `<span style="${MUTED}">The link can only be used once{{#if expiresAt}} and is valid until {{expiresAt}}{{/if}}. If you did not request it, you can ignore this e-mail.</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

here is your personal link to sign in to your customer account – no password needed:

{{loginUrl}}

The link can only be used once{{#if expiresAt}} and is valid until {{expiresAt}}{{/if}}. If you did not request it, you can ignore this e-mail.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Dein Anmeldelink für {{shopName}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'hier ist dein persönlicher Link, mit dem du dich ohne Passwort in deinem Kundenkonto anmelden kannst.',
        ),
        button('de', 'loginUrl', 'Jetzt anmelden'),
        paragraph(
          `<span style="${MUTED}">Der Link kann nur einmal verwendet werden{{#if expiresAt}} und ist gültig bis {{expiresAt}}{{/if}}. Falls du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

hier ist dein persönlicher Link, mit dem du dich ohne Passwort in deinem Kundenkonto anmelden kannst:

{{loginUrl}}

Der Link kann nur einmal verwendet werden{{#if expiresAt}} und ist gültig bis {{expiresAt}}{{/if}}. Falls du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.

${COMMON.de.regardsText}`,
    }),
  },

  SMTP_TEST: {
    en: () => ({
      subject: 'Test e-mail from {{shopName}}',
      html: [
        paragraph('Hello,'),
        paragraph(
          'this is a test e-mail from the Admin Portal of {{shopName}}{{#if sentAt}}, sent on {{sentAt}}{{/if}} to {{recipientEmail}}.',
        ),
        paragraph(
          'If you can read this message, your outgoing mail server is configured correctly.',
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello,

this is a test e-mail from the Admin Portal of {{shopName}}{{#if sentAt}}, sent on {{sentAt}}{{/if}} to {{recipientEmail}}.

If you can read this message, your outgoing mail server is configured correctly.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Test-E-Mail von {{shopName}}',
      html: [
        paragraph('Hallo,'),
        paragraph(
          'dies ist eine Test-E-Mail aus dem Admin-Portal von {{shopName}}{{#if sentAt}}, gesendet am {{sentAt}}{{/if}} an {{recipientEmail}}.',
        ),
        paragraph(
          'Wenn du diese Nachricht lesen kannst, ist dein Postausgangsserver richtig eingerichtet.',
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo,

dies ist eine Test-E-Mail aus dem Admin-Portal von {{shopName}}{{#if sentAt}}, gesendet am {{sentAt}}{{/if}} an {{recipientEmail}}.

Wenn du diese Nachricht lesen kannst, ist dein Postausgangsserver richtig eingerichtet.

${COMMON.de.regardsText}`,
    }),
  },
};

const LOCALES: readonly Locale[] = ['en', 'de'];

/** All default templates (every key × en/de), ready to insert into `email_templates`. */
export function defaultEmailTemplates(): DefaultEmailTemplate[] {
  return EMAIL_TEMPLATE_KEYS.flatMap((key) =>
    LOCALES.map((locale) => {
      const content = CONTENT[key][locale]();
      return {
        key,
        locale,
        subject: content.subject,
        bodyHtml: layout(locale, content.html),
        bodyText: content.text + textFooter(locale),
      };
    }),
  );
}
