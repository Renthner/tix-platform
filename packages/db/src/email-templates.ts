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
  <a href="{{${urlVar}}}" style="display:inline-block;background:{{accentColor}};color:{{brandForegroundColor}};text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">${label}</a>
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

const CALENDAR_TEXT = {
  en: 'Add the event to your calendar and find your way:',
  de: 'Trage die Veranstaltung in deinen Kalender ein und finde den Weg:',
} as const;

/**
 * "Add to calendar" / directions buttons per event (`{{calendarLinks}}` is generated HTML,
 * empty without a public URL or events). Like the ticket links it sits between block elements.
 */
function calendarBlock(locale: Locale): string {
  return `{{#if calendarLinks}}${paragraph(CALENDAR_TEXT[locale])}
{{calendarLinks}}{{/if}}`;
}

function calendarText(locale: Locale): string {
  return `{{#if calendarLinks}}${CALENDAR_TEXT[locale]}
{{calendarLinks}}

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
<tr><td style="background:{{primaryColor}};border-radius:8px 8px 0 0;padding:20px 28px;color:{{brandForegroundColor}};font-size:20px;font-weight:700">{{shopHeader}}</td></tr>
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
          '{{paymentQrCode}}',
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
          '{{paymentQrCode}}',
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
        calendarBlock('en'),
        '{{itemsTable}}',
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph('We are looking forward to seeing you!'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

we have received your payment of {{amount}} – thank you very much! Your order {{orderNumber}} is fully paid and your seats are confirmed.

{{#if invoiceNumber}}Your invoice {{invoiceNumber}} is attached to this e-mail.

{{/if}}${ticketsSentence('Your tickets are attached to this e-mail as PDF. You can also download them at any time on your order page.', 'You can download your tickets individually below or at any time on your order page.')}

${ticketLinksText('en')}${calendarText('en')}{{itemsTable}}

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
        calendarBlock('de'),
        '{{itemsTable}}',
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph('Wir freuen uns auf dich!'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

wir haben deine Zahlung über {{amount}} erhalten – herzlichen Dank! Deine Bestellung {{orderNumber}} ist vollständig bezahlt und deine Plätze sind fest gebucht.

{{#if invoiceNumber}}Deine Rechnung {{invoiceNumber}} findest du im Anhang dieser E-Mail.

{{/if}}${ticketsSentence('Deine Tickets findest du als PDF im Anhang dieser E-Mail. Du kannst sie außerdem jederzeit auf der Seite deiner Bestellung herunterladen.', 'Du kannst deine Tickets unten einzeln oder jederzeit auf der Seite deiner Bestellung herunterladen.')}

${ticketLinksText('de')}${calendarText('de')}{{itemsTable}}

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
          '{{paymentQrCode}}',
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
          '{{paymentQrCode}}',
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
          '{{#if refundAmount}}we are refunding <strong>{{refundAmount}}</strong>{{else}}we have cancelled tickets{{/if}} for your order {{orderNumber}}.',
        ),
        '{{#if refundViaPaypal}}' +
          paragraph(
            'The money is going back to your PayPal account; it usually shows up within a few days.',
          ) +
          '{{/if}}{{#if refundManual}}' +
          paragraph(
            'We will transfer the amount to you (to the account you paid from, if we know it). This can take a few days.',
          ) +
          '{{/if}}',
        '{{#if creditNoteNumber}}' +
          paragraph('Your credit note {{creditNoteNumber}} is attached to this e-mail.') +
          '{{/if}}',
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

{{#if refundAmount}}we are refunding {{refundAmount}}{{else}}we have cancelled tickets{{/if}} for your order {{orderNumber}}.

{{#if refundViaPaypal}}The money is going back to your PayPal account; it usually shows up within a few days.

{{/if}}{{#if refundManual}}We will transfer the amount to you (to the account you paid from, if we know it). This can take a few days.

{{/if}}{{#if creditNoteNumber}}Your credit note {{creditNoteNumber}} is attached to this e-mail.

{{/if}}${orderLink('en')}${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Erstattung zu deiner Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          '{{#if refundAmount}}wir erstatten dir <strong>{{refundAmount}}</strong>{{else}}wir haben Tickets storniert{{/if}} (Bestellung {{orderNumber}}).',
        ),
        '{{#if refundViaPaypal}}' +
          paragraph(
            'Das Geld geht zurück auf dein PayPal-Konto; es erscheint dort meist innerhalb weniger Tage.',
          ) +
          '{{/if}}{{#if refundManual}}' +
          paragraph(
            'Wir überweisen dir den Betrag (auf das Konto, von dem du bezahlt hast, sofern uns das bekannt ist). Das kann einige Tage dauern.',
          ) +
          '{{/if}}',
        '{{#if creditNoteNumber}}' +
          paragraph(
            'Deine Rechnungskorrektur {{creditNoteNumber}} findest du im Anhang dieser E-Mail.',
          ) +
          '{{/if}}',
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

{{#if refundAmount}}wir erstatten dir {{refundAmount}}{{else}}wir haben Tickets storniert{{/if}} (Bestellung {{orderNumber}}).

{{#if refundViaPaypal}}Das Geld geht zurück auf dein PayPal-Konto; es erscheint dort meist innerhalb weniger Tage.

{{/if}}{{#if refundManual}}Wir überweisen dir den Betrag (auf das Konto, von dem du bezahlt hast, sofern uns das bekannt ist). Das kann einige Tage dauern.

{{/if}}{{#if creditNoteNumber}}Deine Rechnungskorrektur {{creditNoteNumber}} findest du im Anhang dieser E-Mail.

{{/if}}${orderLink('de')}${COMMON.de.regardsText}`,
    }),
  },

  ADDITIONAL_PAYMENT_REQUEST: {
    en: () => ({
      subject: 'Additional payment for your order {{orderNumber}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'the tariff of the following tickets in your order {{orderNumber}} has been changed to a higher-priced one. This results in an additional payment of <strong>{{adjustmentAmount}}</strong>.{{#if adjustmentReason}} Reason: {{adjustmentReason}}{{/if}}',
        ),
        '{{adjustmentItems}}',
        paragraph(
          'Your tickets stay valid in the meantime. Please open your order, check the change and confirm that you want to pay; afterwards you can pay by PayPal or bank transfer.',
        ),
        button('en', 'orderUrl', 'Review and confirm'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

the tariff of the following tickets in your order {{orderNumber}} has been changed to a higher-priced one. This results in an additional payment of {{adjustmentAmount}}.{{#if adjustmentReason}} Reason: {{adjustmentReason}}{{/if}}

{{adjustmentItems}}

Your tickets stay valid in the meantime. Please open your order, check the change and confirm that you want to pay; afterwards you can pay by PayPal or bank transfer.

${orderLink('en')}${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Nachzahlung zu deiner Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'der Tarif der folgenden Tickets in deiner Bestellung {{orderNumber}} wurde auf einen höheren Preis geändert. Daraus ergibt sich eine Nachzahlung von <strong>{{adjustmentAmount}}</strong>.{{#if adjustmentReason}} Grund: {{adjustmentReason}}{{/if}}',
        ),
        '{{adjustmentItems}}',
        paragraph(
          'Deine Tickets bleiben in der Zwischenzeit gültig. Bitte öffne deine Bestellung, prüfe die Änderung und bestätige die Zahlungspflicht; anschließend kannst du per PayPal oder Überweisung bezahlen.',
        ),
        button('de', 'orderUrl', 'Prüfen und bestätigen'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

der Tarif der folgenden Tickets in deiner Bestellung {{orderNumber}} wurde auf einen höheren Preis geändert. Daraus ergibt sich eine Nachzahlung von {{adjustmentAmount}}.{{#if adjustmentReason}} Grund: {{adjustmentReason}}{{/if}}

{{adjustmentItems}}

Deine Tickets bleiben in der Zwischenzeit gültig. Bitte öffne deine Bestellung, prüfe die Änderung und bestätige die Zahlungspflicht; anschließend kannst du per PayPal oder Überweisung bezahlen.

${orderLink('de')}${COMMON.de.regardsText}`,
    }),
  },

  ADDITIONAL_PAYMENT_REMINDER: {
    en: () => ({
      subject: 'Reminder: additional payment for your order {{orderNumber}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'the additional payment of <strong>{{adjustmentAmount}}</strong> for your order {{orderNumber}} is still open. If you have already paid, please disregard this e-mail.',
        ),
        '{{adjustmentItems}}',
        paragraph(
          'Please open your order, confirm the additional payment and pay by PayPal or bank transfer.',
        ),
        button('en', 'orderUrl', 'Review and pay'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

the additional payment of {{adjustmentAmount}} for your order {{orderNumber}} is still open. If you have already paid, please disregard this e-mail.

{{adjustmentItems}}

Please open your order, confirm the additional payment and pay by PayPal or bank transfer.

${orderLink('en')}${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Erinnerung: Nachzahlung zu deiner Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'die Nachzahlung von <strong>{{adjustmentAmount}}</strong> zu deiner Bestellung {{orderNumber}} ist noch offen. Hast du bereits bezahlt, betrachte diese E-Mail bitte als gegenstandslos.',
        ),
        '{{adjustmentItems}}',
        paragraph(
          'Bitte öffne deine Bestellung, bestätige die Nachzahlung und bezahle per PayPal oder Überweisung.',
        ),
        button('de', 'orderUrl', 'Prüfen und bezahlen'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

die Nachzahlung von {{adjustmentAmount}} zu deiner Bestellung {{orderNumber}} ist noch offen. Hast du bereits bezahlt, betrachte diese E-Mail bitte als gegenstandslos.

{{adjustmentItems}}

Bitte öffne deine Bestellung, bestätige die Nachzahlung und bezahle per PayPal oder Überweisung.

${orderLink('de')}${COMMON.de.regardsText}`,
    }),
  },

  ADDITIONAL_PAYMENT_CANCELLED: {
    en: () => ({
      subject: 'Additional payment for your order {{orderNumber}} withdrawn',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'the additional payment of <strong>{{adjustmentAmount}}</strong> for your order {{orderNumber}} has been withdrawn. You do not have to pay anything. If you have already transferred the amount, please contact us.',
        ),
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

the additional payment of {{adjustmentAmount}} for your order {{orderNumber}} has been withdrawn. You do not have to pay anything. If you have already transferred the amount, please contact us.

${orderLink('en')}${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Nachzahlung zu deiner Bestellung {{orderNumber}} zurückgenommen',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'die Nachzahlung von <strong>{{adjustmentAmount}}</strong> zu deiner Bestellung {{orderNumber}} wurde zurückgenommen. Du musst nichts bezahlen. Hast du den Betrag bereits überwiesen, melde dich bitte bei uns.',
        ),
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

die Nachzahlung von {{adjustmentAmount}} zu deiner Bestellung {{orderNumber}} wurde zurückgenommen. Du musst nichts bezahlen. Hast du den Betrag bereits überwiesen, melde dich bitte bei uns.

${orderLink('de')}${COMMON.de.regardsText}`,
    }),
  },

  ADDITIONAL_PAYMENT_RECEIVED: {
    en: () => ({
      subject: 'Additional payment received – your order {{orderNumber}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'we have received your additional payment of <strong>{{adjustmentAmount}}</strong> for your order {{orderNumber}} – thank you very much! The tickets below now have the new tariff:',
        ),
        '{{adjustmentItems}}',
        '{{#if adjustmentNewInvoiceNumber}}' +
          paragraph(
            '{{#if adjustmentCreditNoteNumber}}Attached you will find the invoice correction <strong>{{adjustmentCreditNoteNumber}}</strong>, which cancels the original invoice {{adjustmentOldInvoiceNumber}}, and the new invoice <strong>{{adjustmentNewInvoiceNumber}}</strong>.{{else}}Attached you will find your invoice <strong>{{adjustmentNewInvoiceNumber}}</strong>.{{/if}} The new invoice shows the total amount of {{adjustmentNewTotal}}, of which {{adjustmentPreviouslyPaid}} were already paid plus the additional payment of {{adjustmentAmount}}. Nothing else is due.',
          ) +
          '{{/if}}',
        paragraph(
          ticketsSentence(
            'Your new tickets are attached as PDF; they replace the previous ones. You can also download them at any time on your order page.',
            'Your new tickets replace the previous ones. You can download them individually below or at any time on your order page.',
          ),
        ),
        ticketLinksBlock('en'),
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

we have received your additional payment of {{adjustmentAmount}} for your order {{orderNumber}} – thank you very much! The tickets below now have the new tariff:

{{adjustmentItems}}

{{#if adjustmentNewInvoiceNumber}}{{#if adjustmentCreditNoteNumber}}Attached you will find the invoice correction {{adjustmentCreditNoteNumber}}, which cancels the original invoice {{adjustmentOldInvoiceNumber}}, and the new invoice {{adjustmentNewInvoiceNumber}}.{{else}}Attached you will find your invoice {{adjustmentNewInvoiceNumber}}.{{/if}} The new invoice shows the total amount of {{adjustmentNewTotal}}, of which {{adjustmentPreviouslyPaid}} were already paid plus the additional payment of {{adjustmentAmount}}. Nothing else is due.

{{/if}}{{#if ticketsAttached}}Your new tickets are attached as PDF; they replace the previous ones. You can also download them at any time on your order page.{{else}}Your new tickets replace the previous ones. You can download them individually below or at any time on your order page.{{/if}}

${ticketLinksText('en')}${orderLink('en')}${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Nachzahlung eingegangen – deine Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'wir haben deine Nachzahlung von <strong>{{adjustmentAmount}}</strong> zu deiner Bestellung {{orderNumber}} erhalten – vielen Dank! Die folgenden Tickets haben jetzt den neuen Tarif:',
        ),
        '{{adjustmentItems}}',
        '{{#if adjustmentNewInvoiceNumber}}' +
          paragraph(
            '{{#if adjustmentCreditNoteNumber}}Im Anhang findest du die Rechnungskorrektur <strong>{{adjustmentCreditNoteNumber}}</strong>, die die ursprüngliche Rechnung {{adjustmentOldInvoiceNumber}} storniert, und die neue Rechnung <strong>{{adjustmentNewInvoiceNumber}}</strong>.{{else}}Im Anhang findest du deine Rechnung <strong>{{adjustmentNewInvoiceNumber}}</strong>.{{/if}} Die neue Rechnung weist den Gesamtbetrag von {{adjustmentNewTotal}} aus, davon bereits bezahlt {{adjustmentPreviouslyPaid}} + Nachzahlung {{adjustmentAmount}}. Es ist nichts weiter zu zahlen.',
          ) +
          '{{/if}}',
        paragraph(
          ticketsSentence(
            'Deine neuen Tickets hängen als PDF an; sie ersetzen die bisherigen. Du kannst sie außerdem jederzeit auf deiner Bestellseite herunterladen.',
            'Deine neuen Tickets ersetzen die bisherigen. Du kannst sie unten einzeln oder jederzeit auf deiner Bestellseite herunterladen.',
          ),
        ),
        ticketLinksBlock('de'),
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

wir haben deine Nachzahlung von {{adjustmentAmount}} zu deiner Bestellung {{orderNumber}} erhalten – vielen Dank! Die folgenden Tickets haben jetzt den neuen Tarif:

{{adjustmentItems}}

{{#if adjustmentNewInvoiceNumber}}{{#if adjustmentCreditNoteNumber}}Im Anhang findest du die Rechnungskorrektur {{adjustmentCreditNoteNumber}}, die die ursprüngliche Rechnung {{adjustmentOldInvoiceNumber}} storniert, und die neue Rechnung {{adjustmentNewInvoiceNumber}}.{{else}}Im Anhang findest du deine Rechnung {{adjustmentNewInvoiceNumber}}.{{/if}} Die neue Rechnung weist den Gesamtbetrag von {{adjustmentNewTotal}} aus, davon bereits bezahlt {{adjustmentPreviouslyPaid}} + Nachzahlung {{adjustmentAmount}}. Es ist nichts weiter zu zahlen.

{{/if}}{{#if ticketsAttached}}Deine neuen Tickets hängen als PDF an; sie ersetzen die bisherigen. Du kannst sie außerdem jederzeit auf deiner Bestellseite herunterladen.{{else}}Deine neuen Tickets ersetzen die bisherigen. Du kannst sie unten einzeln oder jederzeit auf deiner Bestellseite herunterladen.{{/if}}

${ticketLinksText('de')}${orderLink('de')}${COMMON.de.regardsText}`,
    }),
  },

  ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT: {
    en: () => ({
      subject: 'Tariff changed – settled with your payment – order {{orderNumber}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'the tariff of the tickets below in your order {{orderNumber}} has been changed. The price difference of <strong>{{adjustmentCreditUsed}}</strong> has been settled with the payment you already made (your overpayment) – <strong>you do not have to pay anything</strong>.',
        ),
        '{{adjustmentItems}}',
        '{{#if adjustmentNewInvoiceNumber}}' +
          paragraph(
            '{{#if adjustmentCreditNoteNumber}}Attached you will find the invoice correction <strong>{{adjustmentCreditNoteNumber}}</strong>, which cancels the original invoice {{adjustmentOldInvoiceNumber}}, and the new invoice <strong>{{adjustmentNewInvoiceNumber}}</strong>.{{else}}Attached you will find your invoice <strong>{{adjustmentNewInvoiceNumber}}</strong>.{{/if}} The new invoice shows the total amount of {{adjustmentNewTotal}}, of which {{adjustmentPreviouslyPaid}} were already paid (including the credited overpayment). Nothing else is due.',
          ) +
          '{{/if}}',
        paragraph(
          ticketsSentence(
            'Your new tickets are attached as PDF; they replace the previous ones. You can also download them at any time on your order page.',
            'Your new tickets replace the previous ones. You can download them individually below or at any time on your order page.',
          ),
        ),
        ticketLinksBlock('en'),
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

the tariff of the tickets below in your order {{orderNumber}} has been changed. The price difference of {{adjustmentCreditUsed}} has been settled with the payment you already made (your overpayment) – you do not have to pay anything.

{{adjustmentItems}}

{{#if adjustmentNewInvoiceNumber}}{{#if adjustmentCreditNoteNumber}}Attached you will find the invoice correction {{adjustmentCreditNoteNumber}}, which cancels the original invoice {{adjustmentOldInvoiceNumber}}, and the new invoice {{adjustmentNewInvoiceNumber}}.{{else}}Attached you will find your invoice {{adjustmentNewInvoiceNumber}}.{{/if}} The new invoice shows the total amount of {{adjustmentNewTotal}}, of which {{adjustmentPreviouslyPaid}} were already paid (including the credited overpayment). Nothing else is due.

{{/if}}{{#if ticketsAttached}}Your new tickets are attached as PDF; they replace the previous ones. You can also download them at any time on your order page.{{else}}Your new tickets replace the previous ones. You can download them individually below or at any time on your order page.{{/if}}

${ticketLinksText('en')}${orderLink('en')}${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject:
        'Tarif geändert – mit deiner bereits geleisteten Zahlung verrechnet – Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'der Tarif der folgenden Tickets in deiner Bestellung {{orderNumber}} wurde geändert. Die Preisdifferenz von <strong>{{adjustmentCreditUsed}}</strong> wurde mit deiner bereits geleisteten Zahlung (deiner Überzahlung) verrechnet – <strong>du musst nichts nachzahlen</strong>.',
        ),
        '{{adjustmentItems}}',
        '{{#if adjustmentNewInvoiceNumber}}' +
          paragraph(
            '{{#if adjustmentCreditNoteNumber}}Im Anhang findest du die Rechnungskorrektur <strong>{{adjustmentCreditNoteNumber}}</strong>, die die ursprüngliche Rechnung {{adjustmentOldInvoiceNumber}} storniert, und die neue Rechnung <strong>{{adjustmentNewInvoiceNumber}}</strong>.{{else}}Im Anhang findest du deine Rechnung <strong>{{adjustmentNewInvoiceNumber}}</strong>.{{/if}} Die neue Rechnung weist den Gesamtbetrag von {{adjustmentNewTotal}} aus, davon bereits bezahlt {{adjustmentPreviouslyPaid}} (einschließlich der verrechneten Überzahlung). Es ist nichts weiter zu zahlen.',
          ) +
          '{{/if}}',
        paragraph(
          ticketsSentence(
            'Deine neuen Tickets hängen als PDF an; sie ersetzen die bisherigen. Du kannst sie außerdem jederzeit auf deiner Bestellseite herunterladen.',
            'Deine neuen Tickets ersetzen die bisherigen. Du kannst sie unten einzeln oder jederzeit auf deiner Bestellseite herunterladen.',
          ),
        ),
        ticketLinksBlock('de'),
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

der Tarif der folgenden Tickets in deiner Bestellung {{orderNumber}} wurde geändert. Die Preisdifferenz von {{adjustmentCreditUsed}} wurde mit deiner bereits geleisteten Zahlung (deiner Überzahlung) verrechnet – du musst nichts nachzahlen.

{{adjustmentItems}}

{{#if adjustmentNewInvoiceNumber}}{{#if adjustmentCreditNoteNumber}}Im Anhang findest du die Rechnungskorrektur {{adjustmentCreditNoteNumber}}, die die ursprüngliche Rechnung {{adjustmentOldInvoiceNumber}} storniert, und die neue Rechnung {{adjustmentNewInvoiceNumber}}.{{else}}Im Anhang findest du deine Rechnung {{adjustmentNewInvoiceNumber}}.{{/if}} Die neue Rechnung weist den Gesamtbetrag von {{adjustmentNewTotal}} aus, davon bereits bezahlt {{adjustmentPreviouslyPaid}} (einschließlich der verrechneten Überzahlung). Es ist nichts weiter zu zahlen.

{{/if}}{{#if ticketsAttached}}Deine neuen Tickets hängen als PDF an; sie ersetzen die bisherigen. Du kannst sie außerdem jederzeit auf deiner Bestellseite herunterladen.{{else}}Deine neuen Tickets ersetzen die bisherigen. Du kannst sie unten einzeln oder jederzeit auf deiner Bestellseite herunterladen.{{/if}}

${ticketLinksText('de')}${orderLink('de')}${COMMON.de.regardsText}`,
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
        calendarBlock('en'),
        '{{itemsTable}}',
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph('We are looking forward to seeing you!'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

as requested, here are the details of your order {{orderNumber}} once again. {{#if ticketsAttached}}Your tickets are attached to this e-mail as PDF and can also be downloaded at any time on your order page.{{else}}You can download your tickets individually below or at any time on your order page.{{/if}}

${ticketLinksText('en')}${calendarText('en')}{{itemsTable}}

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
        calendarBlock('de'),
        '{{itemsTable}}',
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph('Wir freuen uns auf dich!'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

wie gewünscht senden wir dir die Angaben zu deiner Bestellung {{orderNumber}} noch einmal. {{#if ticketsAttached}}Deine Tickets findest du als PDF im Anhang dieser E-Mail; du kannst sie außerdem jederzeit auf der Seite deiner Bestellung herunterladen.{{else}}Du kannst deine Tickets unten einzeln oder jederzeit auf der Seite deiner Bestellung herunterladen.{{/if}}

${ticketLinksText('de')}${calendarText('de')}{{itemsTable}}

${orderLink('de')}Wir freuen uns auf dich!

${COMMON.de.regardsText}`,
    }),
  },

  TICKET_TRANSFER_RECEIVED: {
    en: () => ({
      subject: 'A ticket for {{eventTitle}} was passed on to you',
      html: [
        paragraph('Hello{{#if recipientName}} {{recipientName}}{{/if}},'),
        paragraph(
          '<strong>{{senderName}}</strong> has passed a ticket for <strong>{{eventTitle}}</strong> on to you. {{#if eventDate}}It is valid for {{eventDate}}{{#if eventVenue}} · {{eventVenue}}{{/if}}. {{/if}}{{#if ticketWithoutSeat}}Your ticket{{else}}Your seat{{/if}}: <strong>{{ticketPlace}}</strong> (ticket {{ticketCode}}).',
        ),
        '{{#if transferMessage}}<blockquote style="margin:0 0 16px;padding:8px 14px;border-left:3px solid #d4d4d8;color:#3f3f46;white-space:pre-line">{{transferMessage}}</blockquote>{{/if}}',
        button('en', 'ticketPageUrl', 'Open your ticket'),
        paragraph(
          'You can download the ticket as PDF{{#if appleWalletUrl}}, add it to Apple Wallet{{/if}}{{#if googleWalletUrl}} or add it to Google Wallet{{/if}} on that page. Please bring it to the entrance – on your phone or printed.',
        ),
        '{{#if ticketPdfUrl}}<p style="margin:0 0 16px">' +
          `<a href="{{ticketPdfUrl}}" style="color:#18181b">Download PDF</a>` +
          '{{#if appleWalletUrl}} · <a href="{{appleWalletUrl}}" style="color:#18181b">Apple Wallet</a>{{/if}}' +
          '{{#if googleWalletUrl}} · <a href="{{googleWalletUrl}}" style="color:#18181b">Google Wallet</a>{{/if}}</p>{{/if}}',
        paragraph('We are looking forward to seeing you!'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if recipientName}} {{recipientName}}{{/if}},

{{senderName}} has passed a ticket for {{eventTitle}} on to you. {{#if eventDate}}It is valid for {{eventDate}}{{#if eventVenue}} · {{eventVenue}}{{/if}}. {{/if}}{{#if ticketWithoutSeat}}Your ticket{{else}}Your seat{{/if}}: {{ticketPlace}} (ticket {{ticketCode}}).

{{#if transferMessage}}"{{transferMessage}}"

{{/if}}Open your ticket: {{ticketPageUrl}}
PDF: {{ticketPdfUrl}}
{{#if appleWalletUrl}}Apple Wallet: {{appleWalletUrl}}
{{/if}}{{#if googleWalletUrl}}Google Wallet: {{googleWalletUrl}}
{{/if}}
Please bring the ticket to the entrance – on your phone or printed.

We are looking forward to seeing you!

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Dir wurde ein Ticket für {{eventTitle}} weitergegeben',
      html: [
        paragraph('Hallo{{#if recipientName}} {{recipientName}}{{/if}},'),
        paragraph(
          '<strong>{{senderName}}</strong> hat ein Ticket für <strong>{{eventTitle}}</strong> an dich weitergegeben. {{#if eventDate}}Es gilt für {{eventDate}}{{#if eventVenue}} · {{eventVenue}}{{/if}}. {{/if}}{{#if ticketWithoutSeat}}Dein Ticket{{else}}Dein Platz{{/if}}: <strong>{{ticketPlace}}</strong> (Ticket {{ticketCode}}).',
        ),
        '{{#if transferMessage}}<blockquote style="margin:0 0 16px;padding:8px 14px;border-left:3px solid #d4d4d8;color:#3f3f46;white-space:pre-line">{{transferMessage}}</blockquote>{{/if}}',
        button('de', 'ticketPageUrl', 'Ticket öffnen'),
        paragraph(
          'Auf dieser Seite kannst du das Ticket als PDF herunterladen{{#if appleWalletUrl}}, zu Apple Wallet hinzufügen{{/if}}{{#if googleWalletUrl}} oder zu Google Wallet hinzufügen{{/if}}. Bitte bring es zum Einlass mit – auf dem Handy oder ausgedruckt.',
        ),
        '{{#if ticketPdfUrl}}<p style="margin:0 0 16px">' +
          `<a href="{{ticketPdfUrl}}" style="color:#18181b">PDF herunterladen</a>` +
          '{{#if appleWalletUrl}} · <a href="{{appleWalletUrl}}" style="color:#18181b">Apple Wallet</a>{{/if}}' +
          '{{#if googleWalletUrl}} · <a href="{{googleWalletUrl}}" style="color:#18181b">Google Wallet</a>{{/if}}</p>{{/if}}',
        paragraph('Wir freuen uns auf dich!'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if recipientName}} {{recipientName}}{{/if}},

{{senderName}} hat ein Ticket für {{eventTitle}} an dich weitergegeben. {{#if eventDate}}Es gilt für {{eventDate}}{{#if eventVenue}} · {{eventVenue}}{{/if}}. {{/if}}{{#if ticketWithoutSeat}}Dein Ticket{{else}}Dein Platz{{/if}}: {{ticketPlace}} (Ticket {{ticketCode}}).

{{#if transferMessage}}"{{transferMessage}}"

{{/if}}Ticket öffnen: {{ticketPageUrl}}
PDF: {{ticketPdfUrl}}
{{#if appleWalletUrl}}Apple Wallet: {{appleWalletUrl}}
{{/if}}{{#if googleWalletUrl}}Google Wallet: {{googleWalletUrl}}
{{/if}}
Bitte bring das Ticket zum Einlass mit – auf dem Handy oder ausgedruckt.

Wir freuen uns auf dich!

${COMMON.de.regardsText}`,
    }),
  },

  TICKET_TRANSFER_SENT: {
    en: () => ({
      subject: 'Ticket passed on – order {{orderNumber}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'the ticket for <strong>{{ticketPlace}}</strong> ({{eventTitle}}) in your order {{orderNumber}} now belongs to <strong>{{recipientName}}</strong> ({{newHolderEmail}}). We sent the new ticket to that address.',
        ),
        paragraph(
          '<strong>Your previous QR code is no longer valid</strong> – it will be rejected at the entrance. Your order and invoice stay unchanged.',
        ),
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

the ticket for {{ticketPlace}} ({{eventTitle}}) in your order {{orderNumber}} now belongs to {{recipientName}} ({{newHolderEmail}}). We sent the new ticket to that address.

Your previous QR code is no longer valid – it will be rejected at the entrance. Your order and invoice stay unchanged.

${orderLink('en')}${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Ticket weitergegeben – Bestellung {{orderNumber}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'das Ticket für <strong>{{ticketPlace}}</strong> ({{eventTitle}}) aus deiner Bestellung {{orderNumber}} gehört jetzt <strong>{{recipientName}}</strong> ({{newHolderEmail}}). Das neue Ticket haben wir an diese Adresse geschickt.',
        ),
        paragraph(
          '<strong>Dein bisheriger QR-Code ist nicht mehr gültig</strong> – er wird am Einlass abgewiesen. Deine Bestellung und deine Rechnung bleiben unverändert.',
        ),
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

das Ticket für {{ticketPlace}} ({{eventTitle}}) aus deiner Bestellung {{orderNumber}} gehört jetzt {{recipientName}} ({{newHolderEmail}}). Das neue Ticket haben wir an diese Adresse geschickt.

Dein bisheriger QR-Code ist nicht mehr gültig – er wird am Einlass abgewiesen. Deine Bestellung und deine Rechnung bleiben unverändert.

${orderLink('de')}${COMMON.de.regardsText}`,
    }),
  },

  TICKET_HOLDER_UPDATED: {
    en: () => ({
      subject: 'Your ticket for {{eventTitle}} was updated',
      html: [
        paragraph('Hello{{#if recipientName}} {{recipientName}}{{/if}},'),
        paragraph(
          'your ticket for <strong>{{eventTitle}}</strong> was updated by the organiser. {{#if eventDate}}It is valid for {{eventDate}}{{#if eventVenue}} · {{eventVenue}}{{/if}}. {{/if}}{{#if ticketWithoutSeat}}Your ticket{{else}}Your seat{{/if}}: <strong>{{ticketPlace}}</strong> (ticket {{ticketCode}}).',
        ),
        paragraph(
          '<strong>Your previous QR code is no longer valid.</strong> Please use the new ticket from now on.',
        ),
        button('en', 'ticketPageUrl', 'Open your ticket'),
        '{{#if ticketPdfUrl}}<p style="margin:0 0 16px">' +
          `<a href="{{ticketPdfUrl}}" style="color:#18181b">Download PDF</a>` +
          '{{#if appleWalletUrl}} · <a href="{{appleWalletUrl}}" style="color:#18181b">Apple Wallet</a>{{/if}}' +
          '{{#if googleWalletUrl}} · <a href="{{googleWalletUrl}}" style="color:#18181b">Google Wallet</a>{{/if}}</p>{{/if}}',
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if recipientName}} {{recipientName}}{{/if}},

your ticket for {{eventTitle}} was updated by the organiser. {{#if eventDate}}It is valid for {{eventDate}}{{#if eventVenue}} · {{eventVenue}}{{/if}}. {{/if}}{{#if ticketWithoutSeat}}Your ticket{{else}}Your seat{{/if}}: {{ticketPlace}} (ticket {{ticketCode}}).

Your previous QR code is no longer valid. Please use the new ticket from now on.

Open your ticket: {{ticketPageUrl}}
PDF: {{ticketPdfUrl}}
{{#if appleWalletUrl}}Apple Wallet: {{appleWalletUrl}}
{{/if}}{{#if googleWalletUrl}}Google Wallet: {{googleWalletUrl}}
{{/if}}
${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Dein Ticket für {{eventTitle}} wurde aktualisiert',
      html: [
        paragraph('Hallo{{#if recipientName}} {{recipientName}}{{/if}},'),
        paragraph(
          'dein Ticket für <strong>{{eventTitle}}</strong> wurde vom Veranstalter aktualisiert. {{#if eventDate}}Es gilt für {{eventDate}}{{#if eventVenue}} · {{eventVenue}}{{/if}}. {{/if}}{{#if ticketWithoutSeat}}Dein Ticket{{else}}Dein Platz{{/if}}: <strong>{{ticketPlace}}</strong> (Ticket {{ticketCode}}).',
        ),
        paragraph(
          '<strong>Dein bisheriger QR-Code ist nicht mehr gültig.</strong> Bitte verwende ab jetzt das neue Ticket.',
        ),
        button('de', 'ticketPageUrl', 'Ticket öffnen'),
        '{{#if ticketPdfUrl}}<p style="margin:0 0 16px">' +
          `<a href="{{ticketPdfUrl}}" style="color:#18181b">PDF herunterladen</a>` +
          '{{#if appleWalletUrl}} · <a href="{{appleWalletUrl}}" style="color:#18181b">Apple Wallet</a>{{/if}}' +
          '{{#if googleWalletUrl}} · <a href="{{googleWalletUrl}}" style="color:#18181b">Google Wallet</a>{{/if}}</p>{{/if}}',
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if recipientName}} {{recipientName}}{{/if}},

dein Ticket für {{eventTitle}} wurde vom Veranstalter aktualisiert. {{#if eventDate}}Es gilt für {{eventDate}}{{#if eventVenue}} · {{eventVenue}}{{/if}}. {{/if}}{{#if ticketWithoutSeat}}Dein Ticket{{else}}Dein Platz{{/if}}: {{ticketPlace}} (Ticket {{ticketCode}}).

Dein bisheriger QR-Code ist nicht mehr gültig. Bitte verwende ab jetzt das neue Ticket.

Ticket öffnen: {{ticketPageUrl}}
PDF: {{ticketPdfUrl}}
{{#if appleWalletUrl}}Apple Wallet: {{appleWalletUrl}}
{{/if}}{{#if googleWalletUrl}}Google Wallet: {{googleWalletUrl}}
{{/if}}
${COMMON.de.regardsText}`,
    }),
  },

  TICKET_HOLDER_CANCELLED: {
    en: () => ({
      subject: 'Your ticket for {{eventTitle}} is no longer valid',
      html: [
        paragraph('Hello{{#if recipientName}} {{recipientName}}{{/if}},'),
        paragraph(
          'your ticket for <strong>{{eventTitle}}</strong> ({{ticketPlace}}, ticket {{ticketCode}}) is <strong>no longer valid</strong>: it was cancelled, refunded or reassigned. It will be rejected at the entrance.',
        ),
        paragraph(
          'Any refund goes to the person who bought the ticket. If you have questions, please contact the person who passed the ticket on to you or the organiser.',
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if recipientName}} {{recipientName}}{{/if}},

your ticket for {{eventTitle}} ({{ticketPlace}}, ticket {{ticketCode}}) is no longer valid: it was cancelled, refunded or reassigned. It will be rejected at the entrance.

Any refund goes to the person who bought the ticket. If you have questions, please contact the person who passed the ticket on to you or the organiser.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Dein Ticket für {{eventTitle}} ist nicht mehr gültig',
      html: [
        paragraph('Hallo{{#if recipientName}} {{recipientName}}{{/if}},'),
        paragraph(
          'dein Ticket für <strong>{{eventTitle}}</strong> ({{ticketPlace}}, Ticket {{ticketCode}}) ist <strong>nicht mehr gültig</strong>: Es wurde storniert, erstattet oder neu vergeben. Am Einlass wird es abgewiesen.',
        ),
        paragraph(
          'Eine Erstattung geht an die Person, die das Ticket gekauft hat. Bei Fragen wende dich bitte an die Person, die dir das Ticket weitergegeben hat, oder an den Veranstalter.',
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if recipientName}} {{recipientName}}{{/if}},

dein Ticket für {{eventTitle}} ({{ticketPlace}}, Ticket {{ticketCode}}) ist nicht mehr gültig: Es wurde storniert, erstattet oder neu vergeben. Am Einlass wird es abgewiesen.

Eine Erstattung geht an die Person, die das Ticket gekauft hat. Bei Fragen wende dich bitte an die Person, die dir das Ticket weitergegeben hat, oder an den Veranstalter.

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

  ADMIN_INVITE: {
    en: () => ({
      subject: 'You have been invited to the {{shopName}} Admin Portal',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'you have been invited to the Admin Portal of {{shopName}}. Click the button below to choose your password and activate your account.',
        ),
        button('en', 'inviteUrl', 'Set password and sign in'),
        '{{#if expiresAt}}' +
          paragraph(
            `<span style="${MUTED}">The link is valid until {{expiresAt}} and can only be used once.</span>`,
          ) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">If you did not expect this invitation, you can ignore this e-mail.</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

you have been invited to the Admin Portal of {{shopName}}. Open the following link to choose your password and activate your account:

{{inviteUrl}}

{{#if expiresAt}}The link is valid until {{expiresAt}} and can only be used once.
{{/if}}If you did not expect this invitation, you can ignore this e-mail.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Einladung in das Admin-Portal von {{shopName}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'du wurdest in das Admin-Portal von {{shopName}} eingeladen. Über den Button unten legst du dein Passwort fest und aktivierst dein Konto.',
        ),
        button('de', 'inviteUrl', 'Passwort festlegen und anmelden'),
        '{{#if expiresAt}}' +
          paragraph(
            `<span style="${MUTED}">Der Link ist gültig bis {{expiresAt}} und kann nur einmal verwendet werden.</span>`,
          ) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

du wurdest in das Admin-Portal von {{shopName}} eingeladen. Öffne den folgenden Link, um dein Passwort festzulegen und dein Konto zu aktivieren:

{{inviteUrl}}

{{#if expiresAt}}Der Link ist gültig bis {{expiresAt}} und kann nur einmal verwendet werden.
{{/if}}Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.

${COMMON.de.regardsText}`,
    }),
  },

  ADMIN_PASSWORD_RESET: {
    en: () => ({
      subject: 'Reset your Admin Portal password for {{shopName}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'we have received a request to reset the password of your Admin Portal account. Click the button below to choose a new password.',
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

we have received a request to reset the password of your Admin Portal account. Open the following link to choose a new password:

{{resetUrl}}

{{#if expiresAt}}The link is valid until {{expiresAt}} and can only be used once.
{{/if}}If you did not request this, you can ignore this e-mail – your password remains unchanged.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Passwort für das Admin-Portal von {{shopName}} zurücksetzen',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'wir haben eine Anfrage erhalten, das Passwort deines Admin-Portal-Kontos zurückzusetzen. Über den Button unten kannst du ein neues Passwort festlegen.',
        ),
        button('de', 'resetUrl', 'Neues Passwort festlegen'),
        '{{#if expiresAt}}' +
          paragraph(
            `<span style="${MUTED}">Der Link ist gültig bis {{expiresAt}} und kann nur einmal verwendet werden.</span>`,
          ) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

wir haben eine Anfrage erhalten, das Passwort deines Admin-Portal-Kontos zurückzusetzen. Öffne den folgenden Link, um ein neues Passwort festzulegen:

{{resetUrl}}

{{#if expiresAt}}Der Link ist gültig bis {{expiresAt}} und kann nur einmal verwendet werden.
{{/if}}Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.

${COMMON.de.regardsText}`,
    }),
  },
  WAITLIST_CONFIRM: {
    en: () => ({
      subject: 'Please confirm your waiting list entry for {{eventTitle}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'you asked to be notified when tickets for <strong>{{eventTitle}}</strong> ({{eventDate}}) become available again. Please confirm your e-mail address so that we may write to you.',
        ),
        button('en', 'confirmUrl', 'Confirm waiting list entry'),
        '{{#if expiresAt}}' +
          paragraph(`<span style="${MUTED}">The link is valid until {{expiresAt}}.</span>`) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">We only use your address for this notification. If you did not sign up, simply ignore this e-mail – nothing will be sent to you.</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

you asked to be notified when tickets for {{eventTitle}} ({{eventDate}}) become available again. Please confirm your e-mail address by opening this link:

{{confirmUrl}}

{{#if expiresAt}}The link is valid until {{expiresAt}}.
{{/if}}We only use your address for this notification. If you did not sign up, simply ignore this e-mail – nothing will be sent to you.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Bitte bestätige deinen Wartelisten-Eintrag für {{eventTitle}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'du möchtest benachrichtigt werden, wenn für <strong>{{eventTitle}}</strong> ({{eventDate}}) wieder Tickets verfügbar sind. Bitte bestätige deine E-Mail-Adresse, damit wir dir schreiben dürfen.',
        ),
        button('de', 'confirmUrl', 'Wartelisten-Eintrag bestätigen'),
        '{{#if expiresAt}}' +
          paragraph(`<span style="${MUTED}">Der Link ist gültig bis {{expiresAt}}.</span>`) +
          '{{/if}}',
        paragraph(
          `<span style="${MUTED}">Wir verwenden deine Adresse nur für diese Benachrichtigung. Falls du dich nicht eingetragen hast, ignoriere diese E-Mail einfach – du bekommst dann nichts von uns.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

du möchtest benachrichtigt werden, wenn für {{eventTitle}} ({{eventDate}}) wieder Tickets verfügbar sind. Bitte bestätige deine E-Mail-Adresse über diesen Link:

{{confirmUrl}}

{{#if expiresAt}}Der Link ist gültig bis {{expiresAt}}.
{{/if}}Wir verwenden deine Adresse nur für diese Benachrichtigung. Falls du dich nicht eingetragen hast, ignoriere diese E-Mail einfach – du bekommst dann nichts von uns.

${COMMON.de.regardsText}`,
    }),
  },
  WAITLIST_AVAILABLE: {
    en: () => ({
      subject: 'Tickets available again: {{eventTitle}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'good news: tickets for <strong>{{eventTitle}}</strong> ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) are available again. Everybody on the waiting list is notified at the same time and no seats are reserved – whoever books first gets them, so please be quick.',
        ),
        button('en', 'eventUrl', 'Get tickets now'),
        paragraph(
          `<span style="${MUTED}">You stay on the waiting list and are notified again if tickets become available after a sell-out – unless you book or <a href="{{unsubscribeUrl}}" style="color:#52525b">remove yourself from the list</a>.</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

good news: tickets for {{eventTitle}} ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) are available again. Everybody on the waiting list is notified at the same time and no seats are reserved – whoever books first gets them, so please be quick.

{{eventUrl}}

You stay on the waiting list and are notified again if tickets become available after a sell-out – unless you book or remove yourself from the list: {{unsubscribeUrl}}

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Wieder Tickets verfügbar: {{eventTitle}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'gute Nachrichten: Für <strong>{{eventTitle}}</strong> ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) sind wieder Tickets verfügbar. Alle auf der Warteliste werden gleichzeitig benachrichtigt und es werden keine Plätze reserviert – wer zuerst bucht, bekommt sie. Sei also schnell.',
        ),
        button('de', 'eventUrl', 'Jetzt Tickets sichern'),
        paragraph(
          `<span style="${MUTED}">Du bleibst auf der Warteliste und wirst erneut benachrichtigt, wenn nach einem Ausverkauf wieder Tickets frei werden – es sei denn, du buchst oder <a href="{{unsubscribeUrl}}" style="color:#52525b">trägst dich von der Liste aus</a>.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

gute Nachrichten: Für {{eventTitle}} ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) sind wieder Tickets verfügbar. Alle auf der Warteliste werden gleichzeitig benachrichtigt und es werden keine Plätze reserviert – wer zuerst bucht, bekommt sie. Sei also schnell.

{{eventUrl}}

Du bleibst auf der Warteliste und wirst erneut benachrichtigt, wenn nach einem Ausverkauf wieder Tickets frei werden – es sei denn, du buchst oder trägst dich von der Liste aus: {{unsubscribeUrl}}

${COMMON.de.regardsText}`,
    }),
  },
  WAITLIST_REMOVED: {
    en: () => ({
      subject: 'You are no longer on the waiting list for {{eventTitle}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'we removed you from the waiting list for <strong>{{eventTitle}}</strong> ({{eventDate}}). You will not receive further notifications for this event.',
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

we removed you from the waiting list for {{eventTitle}} ({{eventDate}}). You will not receive further notifications for this event.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Du bist nicht mehr auf der Warteliste für {{eventTitle}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'wir haben dich von der Warteliste für <strong>{{eventTitle}}</strong> ({{eventDate}}) entfernt. Du erhältst für diese Veranstaltung keine weiteren Benachrichtigungen.',
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

wir haben dich von der Warteliste für {{eventTitle}} ({{eventDate}}) entfernt. Du erhältst für diese Veranstaltung keine weiteren Benachrichtigungen.

${COMMON.de.regardsText}`,
    }),
  },
  ADMIN_ALERT: {
    en: () => ({
      subject: '[{{shopName}}] Warning: {{alertTitle}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph('something in {{shopName}} needs your attention:'),
        paragraph('<strong>{{alertTitle}}</strong>'),
        paragraph('{{alertSummary}}'),
        '{{#if alertSince}}' +
          paragraph(`<span style="${MUTED}">Since: {{alertSince}}</span>`) +
          '{{/if}}',
        button('en', 'alertUrl', 'Open in the admin area'),
        paragraph(
          `<span style="${MUTED}">You receive this warning because it is switched on in your admin account (My account → Warning e-mails).</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

something in {{shopName}} needs your attention:

{{alertTitle}}
{{alertSummary}}
{{#if alertSince}}Since: {{alertSince}}
{{/if}}
{{alertUrl}}

You receive this warning because it is switched on in your admin account (My account → Warning e-mails).

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: '[{{shopName}}] Warnung: {{alertTitle}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph('bei {{shopName}} braucht etwas deine Aufmerksamkeit:'),
        paragraph('<strong>{{alertTitle}}</strong>'),
        paragraph('{{alertSummary}}'),
        '{{#if alertSince}}' +
          paragraph(`<span style="${MUTED}">Seit: {{alertSince}}</span>`) +
          '{{/if}}',
        button('de', 'alertUrl', 'Im Admin-Bereich öffnen'),
        paragraph(
          `<span style="${MUTED}">Du erhältst diese Warnung, weil sie in deinem Admin-Konto eingeschaltet ist (Mein Konto → Warn-E-Mails).</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

bei {{shopName}} braucht etwas deine Aufmerksamkeit:

{{alertTitle}}
{{alertSummary}}
{{#if alertSince}}Seit: {{alertSince}}
{{/if}}
{{alertUrl}}

Du erhältst diese Warnung, weil sie in deinem Admin-Konto eingeschaltet ist (Mein Konto → Warn-E-Mails).

${COMMON.de.regardsText}`,
    }),
  },

  ADMIN_ALERT_RESOLVED: {
    en: () => ({
      subject: '[{{shopName}}] Resolved: {{alertTitle}}',
      html: [
        paragraph(COMMON.en.hello),
        paragraph('good news: the following warning for {{shopName}} has cleared by itself.'),
        paragraph('<strong>{{alertTitle}}</strong>'),
        '{{#if alertSince}}' +
          paragraph(`<span style="${MUTED}">Lasted since: {{alertSince}}</span>`) +
          '{{/if}}',
        button('en', 'alertUrl', 'Open in the admin area'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

good news: the following warning for {{shopName}} has cleared by itself.

{{alertTitle}}
{{#if alertSince}}Lasted since: {{alertSince}}
{{/if}}
{{alertUrl}}

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: '[{{shopName}}] Behoben: {{alertTitle}}',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'gute Nachricht: Die folgende Warnung für {{shopName}} hat sich von selbst erledigt.',
        ),
        paragraph('<strong>{{alertTitle}}</strong>'),
        '{{#if alertSince}}' +
          paragraph(`<span style="${MUTED}">Bestand seit: {{alertSince}}</span>`) +
          '{{/if}}',
        button('de', 'alertUrl', 'Im Admin-Bereich öffnen'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

gute Nachricht: Die folgende Warnung für {{shopName}} hat sich von selbst erledigt.

{{alertTitle}}
{{#if alertSince}}Bestand seit: {{alertSince}}
{{/if}}
{{alertUrl}}

${COMMON.de.regardsText}`,
    }),
  },

  ADMIN_PASSKEY_ADDED: {
    en: () => ({
      subject: '[{{shopName}}] A passkey was added to your account',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'a new passkey <strong>{{passkeyName}}</strong> was added to your admin account for {{shopName}} on {{addedAt}}.',
        ),
        paragraph(
          'If this was you, nothing else is needed. If it was not you, sign in, remove the passkey and change your password right away.',
        ),
        button('en', 'accountUrl', 'Open my account'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

a new passkey "{{passkeyName}}" was added to your admin account for {{shopName}} on {{addedAt}}.

If this was you, nothing else is needed. If it was not you, sign in, remove the passkey and change your password right away.

{{accountUrl}}

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: '[{{shopName}}] Ein Passkey wurde deinem Konto hinzugefügt',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'deinem Admin-Konto bei {{shopName}} wurde am {{addedAt}} ein neuer Passkey <strong>{{passkeyName}}</strong> hinzugefügt.',
        ),
        paragraph(
          'Wenn du das warst, ist nichts weiter nötig. Wenn nicht, melde dich an, entferne den Passkey und ändere sofort dein Passwort.',
        ),
        button('de', 'accountUrl', 'Mein Konto öffnen'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

deinem Admin-Konto bei {{shopName}} wurde am {{addedAt}} ein neuer Passkey "{{passkeyName}}" hinzugefügt.

Wenn du das warst, ist nichts weiter nötig. Wenn nicht, melde dich an, entferne den Passkey und ändere sofort dein Passwort.

{{accountUrl}}

${COMMON.de.regardsText}`,
    }),
  },

  EVENT_CANCELLED: {
    en: () => ({
      subject: '{{eventTitle}} has been cancelled',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'unfortunately <strong>{{eventTitle}}</strong> ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) has been cancelled.',
        ),
        '{{#if eventCancellationReason}}' +
          paragraph('Reason: {{eventCancellationReason}}') +
          '{{/if}}',
        '{{#if orderWasUnpaid}}' +
          paragraph(
            'Your order {{orderNumber}} had not been paid yet. It has been cancelled and you do not have to pay anything.',
          ) +
          '{{else}}' +
          paragraph(
            'Your {{cancelledTicketCount}} ticket(s) of order {{orderNumber}} for this event are no longer valid.',
          ) +
          '{{#if refundAmount}}' +
          paragraph(
            'We refund <strong>{{refundAmount}}</strong>.{{#if refundViaPaypal}} The amount is paid back to your PayPal account automatically.{{/if}}{{#if refundManual}} We will transfer the amount to your bank account – please allow a few days.{{/if}}',
          ) +
          '{{/if}}' +
          '{{#if creditNoteNumber}}' +
          paragraph(
            `<span style="${MUTED}">The credit note {{creditNoteNumber}} is attached to this e-mail.</span>`,
          ) +
          '{{/if}}' +
          '{{/if}}',
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph('We are very sorry for the inconvenience.'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

unfortunately {{eventTitle}} ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) has been cancelled.
{{#if eventCancellationReason}}
Reason: {{eventCancellationReason}}
{{/if}}
{{#if orderWasUnpaid}}Your order {{orderNumber}} had not been paid yet. It has been cancelled and you do not have to pay anything.{{else}}Your {{cancelledTicketCount}} ticket(s) of order {{orderNumber}} for this event are no longer valid.
{{#if refundAmount}}
We refund {{refundAmount}}.{{#if refundViaPaypal}} The amount is paid back to your PayPal account automatically.{{/if}}{{#if refundManual}} We will transfer the amount to your bank account – please allow a few days.{{/if}}
{{/if}}{{#if creditNoteNumber}}
The credit note {{creditNoteNumber}} is attached to this e-mail.
{{/if}}{{/if}}

{{orderUrl}}

We are very sorry for the inconvenience.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: '{{eventTitle}} wurde abgesagt',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'leider wurde <strong>{{eventTitle}}</strong> ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) abgesagt.',
        ),
        '{{#if eventCancellationReason}}' +
          paragraph('Grund: {{eventCancellationReason}}') +
          '{{/if}}',
        '{{#if orderWasUnpaid}}' +
          paragraph(
            'Deine Bestellung {{orderNumber}} war noch nicht bezahlt. Sie wurde storniert und du musst nichts mehr zahlen.',
          ) +
          '{{else}}' +
          paragraph(
            'Deine {{cancelledTicketCount}} Ticket(s) der Bestellung {{orderNumber}} für diese Veranstaltung sind nicht mehr gültig.',
          ) +
          '{{#if refundAmount}}' +
          paragraph(
            'Wir erstatten dir <strong>{{refundAmount}}</strong>.{{#if refundViaPaypal}} Der Betrag wird automatisch auf dein PayPal-Konto zurückgezahlt.{{/if}}{{#if refundManual}} Wir überweisen den Betrag auf dein Bankkonto – bitte rechne mit einigen Tagen.{{/if}}',
          ) +
          '{{/if}}' +
          '{{#if creditNoteNumber}}' +
          paragraph(
            `<span style="${MUTED}">Die Gutschrift {{creditNoteNumber}} hängt dieser E-Mail an.</span>`,
          ) +
          '{{/if}}' +
          '{{/if}}',
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph('Es tut uns sehr leid für die Umstände.'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

leider wurde {{eventTitle}} ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) abgesagt.
{{#if eventCancellationReason}}
Grund: {{eventCancellationReason}}
{{/if}}
{{#if orderWasUnpaid}}Deine Bestellung {{orderNumber}} war noch nicht bezahlt. Sie wurde storniert und du musst nichts mehr zahlen.{{else}}Deine {{cancelledTicketCount}} Ticket(s) der Bestellung {{orderNumber}} für diese Veranstaltung sind nicht mehr gültig.
{{#if refundAmount}}
Wir erstatten dir {{refundAmount}}.{{#if refundViaPaypal}} Der Betrag wird automatisch auf dein PayPal-Konto zurückgezahlt.{{/if}}{{#if refundManual}} Wir überweisen den Betrag auf dein Bankkonto – bitte rechne mit einigen Tagen.{{/if}}
{{/if}}{{#if creditNoteNumber}}
Die Gutschrift {{creditNoteNumber}} hängt dieser E-Mail an.
{{/if}}{{/if}}

{{orderUrl}}

Es tut uns sehr leid für die Umstände.

${COMMON.de.regardsText}`,
    }),
  },

  EVENT_POSTPONED: {
    en: () => ({
      subject: '{{eventTitle}} has been postponed',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          '<strong>{{eventTitle}}</strong> (originally {{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) has been postponed.',
        ),
        '{{#if eventNewDate}}' +
          paragraph('New date: <strong>{{eventNewDate}}</strong>') +
          '{{/if}}',
        '{{#if eventPostponementNote}}' + paragraph('{{eventPostponementNote}}') + '{{/if}}',
        paragraph('Your tickets stay valid – you do not have to do anything.'),
        button('en', 'orderUrl', COMMON.en.viewOrder),
        button('en', 'ticketPageUrl', 'Open your ticket'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

{{eventTitle}} (originally {{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) has been postponed.
{{#if eventNewDate}}
New date: {{eventNewDate}}
{{/if}}{{#if eventPostponementNote}}
{{eventPostponementNote}}
{{/if}}
Your tickets stay valid – you do not have to do anything.

{{#if orderUrl}}{{orderUrl}}
{{/if}}{{#if ticketPageUrl}}Open your ticket: {{ticketPageUrl}}
{{/if}}
${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: '{{eventTitle}} wurde verschoben',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          '<strong>{{eventTitle}}</strong> (ursprünglich {{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) wurde verschoben.',
        ),
        '{{#if eventNewDate}}' +
          paragraph('Neuer Termin: <strong>{{eventNewDate}}</strong>') +
          '{{/if}}',
        '{{#if eventPostponementNote}}' + paragraph('{{eventPostponementNote}}') + '{{/if}}',
        paragraph('Deine Tickets bleiben gültig – du musst nichts weiter tun.'),
        button('de', 'orderUrl', COMMON.de.viewOrder),
        button('de', 'ticketPageUrl', 'Ticket öffnen'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

{{eventTitle}} (ursprünglich {{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) wurde verschoben.
{{#if eventNewDate}}
Neuer Termin: {{eventNewDate}}
{{/if}}{{#if eventPostponementNote}}
{{eventPostponementNote}}
{{/if}}
Deine Tickets bleiben gültig – du musst nichts weiter tun.

{{#if orderUrl}}{{orderUrl}}
{{/if}}{{#if ticketPageUrl}}Ticket öffnen: {{ticketPageUrl}}
{{/if}}
${COMMON.de.regardsText}`,
    }),
  },

  ORDER_MESSAGE: {
    en: () => ({
      subject: '{{messageSubject}}',
      html: [
        paragraph(COMMON.en.hello),
        '{{messageBody}}',
        paragraph(
          `<span style="${MUTED}">This message is about your order {{orderNumber}}.</span>`,
        ),
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

{{messageBody}}

This message is about your order {{orderNumber}}.
{{orderUrl}}

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: '{{messageSubject}}',
      html: [
        paragraph(COMMON.de.hello),
        '{{messageBody}}',
        paragraph(
          `<span style="${MUTED}">Diese Nachricht betrifft deine Bestellung {{orderNumber}}.</span>`,
        ),
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

{{messageBody}}

Diese Nachricht betrifft deine Bestellung {{orderNumber}}.
{{orderUrl}}

${COMMON.de.regardsText}`,
    }),
  },

  EVENT_MESSAGE: {
    en: () => ({
      subject: '{{messageSubject}}',
      html: [
        paragraph(COMMON.en.hello),
        '{{messageBody}}',
        paragraph(
          `<span style="${MUTED}">{{#if ticketHolder}}You receive this message because a ticket for {{eventTitle}} was passed on to you.{{else}}You receive this message because you bought tickets for {{eventTitle}}.{{/if}}</span>`,
        ),
        button('en', 'orderUrl', COMMON.en.viewOrder),
        button('en', 'ticketPageUrl', 'Open your ticket'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

{{messageBody}}

{{#if ticketHolder}}You receive this message because a ticket for {{eventTitle}} was passed on to you.{{else}}You receive this message because you bought tickets for {{eventTitle}}.{{/if}}
{{#if orderUrl}}{{orderUrl}}
{{/if}}{{#if ticketPageUrl}}Open your ticket: {{ticketPageUrl}}
{{/if}}
${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: '{{messageSubject}}',
      html: [
        paragraph(COMMON.de.hello),
        '{{messageBody}}',
        paragraph(
          `<span style="${MUTED}">{{#if ticketHolder}}Du erhältst diese Nachricht, weil dir ein Ticket für {{eventTitle}} weitergegeben wurde.{{else}}Du erhältst diese Nachricht, weil du Tickets für {{eventTitle}} gekauft hast.{{/if}}</span>`,
        ),
        button('de', 'orderUrl', COMMON.de.viewOrder),
        button('de', 'ticketPageUrl', 'Ticket öffnen'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

{{messageBody}}

{{#if ticketHolder}}Du erhältst diese Nachricht, weil dir ein Ticket für {{eventTitle}} weitergegeben wurde.{{else}}Du erhältst diese Nachricht, weil du Tickets für {{eventTitle}} gekauft hast.{{/if}}
{{#if orderUrl}}{{orderUrl}}
{{/if}}{{#if ticketPageUrl}}Ticket öffnen: {{ticketPageUrl}}
{{/if}}
${COMMON.de.regardsText}`,
    }),
  },

  ORDER_EMAIL_CHANGED: {
    en: () => ({
      subject: 'Your e-mail address for order {{orderNumber}} was changed',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'the e-mail address of your order <strong>{{orderNumber}}</strong> was changed from {{previousEmail}} to <strong>{{email}}</strong>. From now on all messages about this order, including tickets, are sent here.',
        ),
        button('en', 'orderUrl', COMMON.en.viewOrder),
        paragraph(
          `<span style="${MUTED}">Earlier links to this order no longer work – please use the link above.</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

the e-mail address of your order {{orderNumber}} was changed from {{previousEmail}} to {{email}}. From now on all messages about this order, including tickets, are sent here.

{{orderUrl}}

Earlier links to this order no longer work – please use the link above.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Die E-Mail-Adresse deiner Bestellung {{orderNumber}} wurde geändert',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'die E-Mail-Adresse deiner Bestellung <strong>{{orderNumber}}</strong> wurde von {{previousEmail}} auf <strong>{{email}}</strong> geändert. Ab jetzt gehen alle Nachrichten zu dieser Bestellung, auch die Tickets, an diese Adresse.',
        ),
        button('de', 'orderUrl', COMMON.de.viewOrder),
        paragraph(
          `<span style="${MUTED}">Frühere Links zu dieser Bestellung funktionieren nicht mehr – bitte nutze den Link oben.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

die E-Mail-Adresse deiner Bestellung {{orderNumber}} wurde von {{previousEmail}} auf {{email}} geändert. Ab jetzt gehen alle Nachrichten zu dieser Bestellung, auch die Tickets, an diese Adresse.

{{orderUrl}}

Frühere Links zu dieser Bestellung funktionieren nicht mehr – bitte nutze den Link oben.

${COMMON.de.regardsText}`,
    }),
  },

  ORDER_EMAIL_CHANGED_OLD: {
    en: () => ({
      subject: 'The e-mail address of order {{orderNumber}} was changed',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'the e-mail address of order <strong>{{orderNumber}}</strong> was changed from this address to a different one. You will not receive messages about this order here any more, and earlier links to it no longer work.',
        ),
        paragraph(
          'If you did not expect this, please reply to this e-mail or contact us right away.',
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

the e-mail address of order {{orderNumber}} was changed from this address to a different one. You will not receive messages about this order here any more, and earlier links to it no longer work.

If you did not expect this, please reply to this e-mail or contact us right away.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Die E-Mail-Adresse der Bestellung {{orderNumber}} wurde geändert',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'die E-Mail-Adresse der Bestellung <strong>{{orderNumber}}</strong> wurde von dieser Adresse auf eine andere geändert. Du erhältst hier keine Nachrichten zu dieser Bestellung mehr, und frühere Links dazu funktionieren nicht mehr.',
        ),
        paragraph(
          'Falls du damit nicht gerechnet hast, antworte bitte auf diese E-Mail oder melde dich sofort bei uns.',
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

die E-Mail-Adresse der Bestellung {{orderNumber}} wurde von dieser Adresse auf eine andere geändert. Du erhältst hier keine Nachrichten zu dieser Bestellung mehr, und frühere Links dazu funktionieren nicht mehr.

Falls du damit nicht gerechnet hast, antworte bitte auf diese E-Mail oder melde dich sofort bei uns.

${COMMON.de.regardsText}`,
    }),
  },

  EVENT_CANCELLED_HOLDER: {
    en: () => ({
      subject: '{{eventTitle}} has been cancelled',
      html: [
        paragraph('Hello{{#if recipientName}} {{recipientName}}{{/if}},'),
        paragraph(
          'unfortunately <strong>{{eventTitle}}</strong> ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) has been cancelled.',
        ),
        '{{#if eventCancellationReason}}' +
          paragraph('Reason: {{eventCancellationReason}}') +
          '{{/if}}',
        paragraph(
          'The ticket(s) passed on to you are <strong>no longer valid</strong>: {{ticketPlace}} (ticket {{ticketCode}}). They will be rejected at the entrance.',
        ),
        paragraph(
          '<strong>About the refund:</strong> the money is refunded to the person who originally bought the ticket(s), not to you. Please settle any refund directly with that person – we cannot pay anything back to you.',
        ),
        paragraph('We are very sorry for the inconvenience.'),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if recipientName}} {{recipientName}}{{/if}},

unfortunately {{eventTitle}} ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) has been cancelled.
{{#if eventCancellationReason}}
Reason: {{eventCancellationReason}}
{{/if}}
The ticket(s) passed on to you are no longer valid: {{ticketPlace}} (ticket {{ticketCode}}). They will be rejected at the entrance.

About the refund: the money is refunded to the person who originally bought the ticket(s), not to you. Please settle any refund directly with that person – we cannot pay anything back to you.

We are very sorry for the inconvenience.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: '{{eventTitle}} wurde abgesagt',
      html: [
        paragraph('Hallo{{#if recipientName}} {{recipientName}}{{/if}},'),
        paragraph(
          'leider wurde <strong>{{eventTitle}}</strong> ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) abgesagt.',
        ),
        '{{#if eventCancellationReason}}' +
          paragraph('Grund: {{eventCancellationReason}}') +
          '{{/if}}',
        paragraph(
          'Die an dich weitergegebenen Tickets sind <strong>nicht mehr gültig</strong>: {{ticketPlace}} (Ticket {{ticketCode}}). Am Einlass werden sie abgewiesen.',
        ),
        paragraph(
          '<strong>Zur Erstattung:</strong> Das Geld erstatten wir an die Person, die die Tickets ursprünglich gekauft hat – nicht an dich. Bitte kläre eine Rückzahlung direkt mit dieser Person; wir können dir nichts erstatten.',
        ),
        paragraph('Es tut uns sehr leid für die Umstände.'),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if recipientName}} {{recipientName}}{{/if}},

leider wurde {{eventTitle}} ({{eventDate}}{{#if eventVenue}}, {{eventVenue}}{{/if}}) abgesagt.
{{#if eventCancellationReason}}
Grund: {{eventCancellationReason}}
{{/if}}
Die an dich weitergegebenen Tickets sind nicht mehr gültig: {{ticketPlace}} (Ticket {{ticketCode}}). Am Einlass werden sie abgewiesen.

Zur Erstattung: Das Geld erstatten wir an die Person, die die Tickets ursprünglich gekauft hat – nicht an dich. Bitte kläre eine Rückzahlung direkt mit dieser Person; wir können dir nichts erstatten.

Es tut uns sehr leid für die Umstände.

${COMMON.de.regardsText}`,
    }),
  },

  CUSTOMER_EMAIL_CHANGED_ORDERS: {
    en: () => ({
      subject: 'Your e-mail address was changed',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'your e-mail address with us was changed from {{previousEmail}} to <strong>{{email}}</strong>. Your current orders were moved to this address as well: from now on all messages about them, including tickets, are sent here.',
        ),
        '{{movedOrders}}',
        paragraph(
          `<span style="${MUTED}">Earlier links to these orders no longer work – please use the links above.</span>`,
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

your e-mail address with us was changed from {{previousEmail}} to {{email}}. Your current orders were moved to this address as well: from now on all messages about them, including tickets, are sent here.

{{movedOrders}}

Earlier links to these orders no longer work – please use the links above.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Deine E-Mail-Adresse wurde geändert',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'deine E-Mail-Adresse bei uns wurde von {{previousEmail}} auf <strong>{{email}}</strong> geändert. Deine aktuellen Bestellungen wurden ebenfalls auf diese Adresse umgestellt: Ab jetzt gehen alle Nachrichten dazu, auch die Tickets, an diese Adresse.',
        ),
        '{{movedOrders}}',
        paragraph(
          `<span style="${MUTED}">Frühere Links zu diesen Bestellungen funktionieren nicht mehr – bitte nutze die Links oben.</span>`,
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

deine E-Mail-Adresse bei uns wurde von {{previousEmail}} auf {{email}} geändert. Deine aktuellen Bestellungen wurden ebenfalls auf diese Adresse umgestellt: Ab jetzt gehen alle Nachrichten dazu, auch die Tickets, an diese Adresse.

{{movedOrders}}

Frühere Links zu diesen Bestellungen funktionieren nicht mehr – bitte nutze die Links oben.

${COMMON.de.regardsText}`,
    }),
  },

  CUSTOMER_EMAIL_CHANGED_OLD: {
    en: () => ({
      subject: 'Your e-mail address was changed',
      html: [
        paragraph(COMMON.en.hello),
        paragraph(
          'the e-mail address we have on file for you was changed from this address to a different one. The following orders were moved along: <strong>{{movedOrderNumbers}}</strong>. You will not receive messages about them here any more, and earlier links to them no longer work.',
        ),
        paragraph(
          'If you did not expect this, please reply to this e-mail or contact us right away.',
        ),
        paragraph(COMMON.en.regards),
      ].join('\n'),
      text: `Hello{{#if firstName}} {{firstName}}{{/if}},

the e-mail address we have on file for you was changed from this address to a different one. The following orders were moved along: {{movedOrderNumbers}}. You will not receive messages about them here any more, and earlier links to them no longer work.

If you did not expect this, please reply to this e-mail or contact us right away.

${COMMON.en.regardsText}`,
    }),
    de: () => ({
      subject: 'Deine E-Mail-Adresse wurde geändert',
      html: [
        paragraph(COMMON.de.hello),
        paragraph(
          'die bei uns hinterlegte E-Mail-Adresse wurde von dieser Adresse auf eine andere geändert. Folgende Bestellungen wurden mit umgestellt: <strong>{{movedOrderNumbers}}</strong>. Du erhältst hier keine Nachrichten zu ihnen mehr, und frühere Links dazu funktionieren nicht mehr.',
        ),
        paragraph(
          'Falls du damit nicht gerechnet hast, antworte bitte auf diese E-Mail oder melde dich sofort bei uns.',
        ),
        paragraph(COMMON.de.regards),
      ].join('\n'),
      text: `Hallo{{#if firstName}} {{firstName}}{{/if}},

die bei uns hinterlegte E-Mail-Adresse wurde von dieser Adresse auf eine andere geändert. Folgende Bestellungen wurden mit umgestellt: {{movedOrderNumbers}}. Du erhältst hier keine Nachrichten zu ihnen mehr, und frühere Links dazu funktionieren nicht mehr.

Falls du damit nicht gerechnet hast, antworte bitte auf diese E-Mail oder melde dich sofort bei uns.

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
