import { defaultEmailTemplates } from '@tix/db';
import { EMAIL_TEMPLATE_KEYS } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_VARIABLES,
  TemplateSyntaxError,
  documentLocale,
  formatIban,
  htmlToText,
  localeCandidates,
  mailTranslator,
  renderTemplate,
  templatePlaceholders,
  toWinAnsi,
  trustedHtml,
} from '../src';

describe('e-mail template renderer', () => {
  it('replaces placeholders and HTML-escapes values in HTML bodies', () => {
    const { output, missing } = renderTemplate(
      '<p>Hello {{ firstName }}, order {{orderNumber}} {{unknown}}</p>',
      { firstName: '<b>Ann & "Bob"</b>', orderNumber: 'A-1' },
      'html',
    );
    expect(output).toBe('<p>Hello &lt;b&gt;Ann &amp; &quot;Bob&quot;&lt;/b&gt;, order A-1 </p>');
    expect(missing).toEqual(['unknown']);
  });

  it('leaves values unescaped in text mode and inserts trusted HTML only as such', () => {
    const table = trustedHtml('<table><tr><td>Seat 1</td></tr></table>', 'Seat 1');
    expect(
      renderTemplate('{{a}} {{itemsTable}}', { a: '<x>', itemsTable: table }, 'text').output,
    ).toBe('<x> Seat 1');
    expect(renderTemplate('{{itemsTable}}', { itemsTable: table }, 'html').output).toBe(
      '<table><tr><td>Seat 1</td></tr></table>',
    );
  });

  it('supports if / else / unless sections incl. nesting', () => {
    const tpl =
      '{{#if iban}}IBAN {{iban}}{{#if bic}} / {{bic}}{{/if}}{{else}}no bank{{/if}}|{{#unless count}}none{{/unless}}';
    expect(renderTemplate(tpl, { iban: 'DE00', bic: 'XX', count: 0 }, 'text').output).toBe(
      'IBAN DE00 / XX|none',
    );
    expect(renderTemplate(tpl, { iban: '', count: 3 }, 'text').output).toBe('no bank|');
    expect(templatePlaceholders(tpl).sort()).toEqual(['bic', 'count', 'iban']);
  });

  it('rejects malformed templates', () => {
    expect(() => renderTemplate('{{#if a}}x', {}, 'html')).toThrow(TemplateSyntaxError);
    expect(() => renderTemplate('x{{/if}}', {}, 'html')).toThrow(TemplateSyntaxError);
    expect(() => renderTemplate('{{#if a}}x{{/unless}}', {}, 'html')).toThrow(TemplateSyntaxError);
    expect(() => renderTemplate('{{else}}', {}, 'html')).toThrow(TemplateSyntaxError);
  });

  it('derives a readable plain-text version from HTML', () => {
    const text = htmlToText(
      '<html><head><style>p{}</style></head><body><p>Hello&nbsp;Ann,</p><p>Line<br>two</p><ul><li>A</li><li>B</li></ul><a href="https://example.org/o?a=1&amp;b=2">View order</a></body></html>',
    );
    expect(text).toBe(
      'Hello Ann,\n\nLine\ntwo\n\n- A\n- B\n\nView order (https://example.org/o?a=1&b=2)',
    );
  });

  it('orders locale candidates: requested, language, shop default, English', () => {
    expect(localeCandidates('de-AT', 'de')).toEqual(['de-AT', 'de', 'en']);
    expect(localeCandidates('fr', 'de')).toEqual(['fr', 'de', 'en']);
    expect(localeCandidates(null, 'en')).toEqual(['en']);
  });
});

describe('default e-mail templates', () => {
  const templates = defaultEmailTemplates();
  const known = new Set<string>([
    ...Object.values(EMAIL_VARIABLES).flat(),
    // passed by the callers of refunds (phase 5)
    'refundAmount',
    'creditNoteNumber',
  ]);

  it('exist for every key in English and German', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      for (const locale of ['en', 'de']) {
        expect(
          templates.some((t) => t.key === key && t.locale === locale),
          `${key}/${locale}`,
        ).toBe(true);
      }
    }
  });

  it('parse and only use documented variables', () => {
    for (const t of templates) {
      for (const source of [t.subject, t.bodyHtml, t.bodyText]) {
        for (const name of templatePlaceholders(source)) {
          expect(known.has(name), `${t.key}/${t.locale}: {{${name}}}`).toBe(true);
        }
      }
    }
  });

  it('contain the complete transfer instructions in the bank transfer confirmation', () => {
    for (const locale of ['en', 'de'] as const) {
      const t = templates.find(
        (x) => x.key === 'ORDER_CONFIRMATION_BANK_TRANSFER' && x.locale === locale,
      )!;
      for (const source of [t.bodyHtml, t.bodyText]) {
        for (const name of [
          'paymentReference',
          'paymentDueDate',
          'iban',
          'bic',
          'bankAccountHolder',
          'amountDue',
          'orderUrl',
          'itemsTable',
        ]) {
          expect(templatePlaceholders(source), `${locale}: ${name}`).toContain(name);
        }
      }
    }
  });
});

describe('document helpers', () => {
  it('translates mail texts with fallback to English', () => {
    expect(mailTranslator('de')('paymentMethods.BANK_TRANSFER')).toBe('Überweisung (Vorkasse)');
    expect(mailTranslator('fr')('paymentMethods.PAYPAL')).toBe('PayPal');
    expect(mailTranslator('de-AT')('invoice.page', { page: 1, pages: 2 })).toBe('Seite 1 von 2');
    expect(documentLocale('de-CH')).toBe('de');
  });

  it('groups IBANs and keeps WinAnsi text drawable', () => {
    expect(formatIban('de89370400440532013000')).toBe('DE89 3704 0044 0532 0130 00');
    expect(toWinAnsi('Jürgen Müller – Straße 5 € „ok“')).toBe('Jürgen Müller – Straße 5 € „ok“');
    expect(toWinAnsi('Łukasz Dvořák ♿ 中')).toBe('Lukasz Dvorák  ?');
    expect(toWinAnsi('1\u202f234')).toBe('1\u00a0234');
  });
});
