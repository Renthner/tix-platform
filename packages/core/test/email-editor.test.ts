import { defaultEmailTemplates } from '@tix/db';
import {
  EMAIL_TEMPLATE_KEYS,
  emailTemplateVariables,
  joinEmailContent,
  protectEmailLogic,
  restoreEmailLogic,
  splitEmailContent,
} from '@tix/shared';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_VARIABLES,
  htmlToText,
  prepareEmailTemplate,
  renderTemplateDraft,
  sampleEmailVariables,
  sanitizeEmailHtml,
  validateEmailTemplate,
} from '../src';

const placeholders = (s: string) => s.match(/\{\{[^{}]*\}\}/g) ?? [];

describe('e-mail template sanitiser', () => {
  it('keeps every shipped default semantically unchanged', () => {
    for (const t of defaultEmailTemplates()) {
      const clean = sanitizeEmailHtml(t.bodyHtml);
      expect(placeholders(clean), `${t.key}/${t.locale}`).toEqual(placeholders(t.bodyHtml));
      expect(clean.startsWith('<!DOCTYPE html>')).toBe(true);
      for (const needle of [
        'background:{{accentColor}}',
        'href="{{orderUrl}}"',
        'background:{{primaryColor}}',
      ]) {
        if (t.bodyHtml.includes(needle)) expect(clean).toContain(needle);
      }
      const shop = { shopName: 'S', primaryColor: '#111111', accentColor: '#222222', iban: 'DE00' };
      const sample = sampleEmailVariables(t.key, t.locale, shop);
      const before = renderTemplateDraft(
        { subject: t.subject, bodyHtml: t.bodyHtml, bodyText: null },
        sample,
      );
      const after = renderTemplateDraft(
        { subject: t.subject, bodyHtml: clean, bodyText: null },
        sample,
      );
      expect(htmlToText(after.html), `${t.key}/${t.locale}`).toBe(htmlToText(before.html));
      expect(sanitizeEmailHtml(clean)).toBe(clean);
    }
  });

  it('removes scripts, handlers, frames, forms, style tags and css url()', () => {
    const clean = sanitizeEmailHtml(
      '<p onclick="x()" style="color:red;background:url(http://evil/x.png);position:fixed">Hi</p>' +
        '<script>alert(1)</script><iframe src="https://evil"></iframe><form action="/x"><input></form>' +
        '<style>p{color:red}</style><img src="https://ok.example/a.png" onerror="x()">',
    );
    expect(clean).toContain('<p style="color:red">Hi</p>');
    expect(clean).not.toMatch(/script|iframe|form|input|onclick|onerror|url\(|position|<style/i);
    expect(clean).toContain('<img src="https://ok.example/a.png"');
  });

  it('only allows http(s), mailto, tel and placeholder links; https images', () => {
    const clean = sanitizeEmailHtml(
      '<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a><a href="/relative">c</a>' +
        '<a href="mailto:{{supportEmail}}">d</a><a href="{{orderUrl}}">e</a><a href="https://x.org">f</a>' +
        '<img src="http://insecure/x.png"><img src="javascript:x"><img src="{{logoUrl}}">',
    );
    expect(clean).not.toMatch(/javascript|data:|relative|insecure/);
    expect(clean).toContain('href="mailto:{{supportEmail}}"');
    expect(clean).toContain('href="{{orderUrl}}"');
    expect(clean).toContain('href="https://x.org"');
    expect(clean).toContain('<img src="{{logoUrl}}"');
  });

  it('makes relative media URLs absolute and keeps the content markers', () => {
    const clean = sanitizeEmailHtml(
      '<p>x</p><!--tix:content--><img src="/api/media/abc"><!--/tix:content--><!-- secret -->',
      { baseUrl: 'http://localhost:8080/' },
    );
    expect(clean).toContain('<img src="http://localhost:8080/api/media/abc"');
    expect(clean).toContain('<!--tix:content-->');
    expect(clean).not.toContain('secret');
  });
});

describe('e-mail template validation', () => {
  const draft = (bodyHtml: string, subject = 'Order {{orderNumber}}') => ({
    subject,
    bodyHtml,
    bodyText: null,
  });

  it('reports unbalanced sections as errors', () => {
    const { errors } = validateEmailTemplate('ORDER_CANCELLED', draft('{{#if iban}}<p>x</p>'));
    expect(errors).toEqual([expect.objectContaining({ field: 'bodyHtml', code: 'syntax' })]);
    expect(validateEmailTemplate('ORDER_CANCELLED', draft('<p>{{/if}}</p>')).errors).toHaveLength(
      1,
    );
    expect(
      validateEmailTemplate('ORDER_CANCELLED', draft('<p>ok</p>', '{{#unless a}}')).errors[0]
        ?.field,
    ).toBe('subject');
  });

  it('warns about placeholders the key does not provide', () => {
    const result = validateEmailTemplate(
      'CUSTOMER_PASSWORD_RESET',
      draft('<p>{{resetUrl}} {{orderNumber}} {{#if walletLinks}}x{{/if}}</p>'),
    );
    expect(result.errors).toEqual([]);
    expect([...new Set(result.warnings.map((w) => w.detail))].sort()).toEqual([
      'orderNumber',
      'walletLinks',
    ]);
  });

  it('validates the sanitised output and strips line breaks from the subject', () => {
    const { draft: clean, validation } = prepareEmailTemplate(
      'ORDER_CANCELLED',
      draft('<p>{{#if iban}}<script>x</script></p>{{/if}}', 'A\nB'),
    );
    expect(clean.subject).toBe('A B');
    expect(validation.errors).toEqual([]);
  });

  it('accepts all shipped defaults without errors or warnings', () => {
    for (const t of defaultEmailTemplates()) {
      const result = validateEmailTemplate(t.key, t);
      expect(result.errors, `${t.key}/${t.locale}`).toEqual([]);
      expect(result.warnings, `${t.key}/${t.locale}`).toEqual([]);
    }
  });

  it('keeps the variable catalogue in line with EMAIL_VARIABLES', () => {
    const known = new Set(
      EMAIL_TEMPLATE_KEYS.flatMap((k) => emailTemplateVariables(k).map((v) => v.name)),
    );
    for (const names of Object.values(EMAIL_VARIABLES)) {
      for (const name of names) expect(known.has(name), name).toBe(true);
    }
  });
});

describe('preview rendering', () => {
  it('renders the ticket mail with and without wallet links', () => {
    const t = defaultEmailTemplates().find(
      (x) => x.key === 'PAYMENT_RECEIVED_TICKETS' && x.locale === 'en',
    )!;
    const shop = { shopName: 'Shop', primaryColor: '#111111', accentColor: '#222222' };
    const sample = sampleEmailVariables(t.key, 'en', shop);
    const withWallet = renderTemplateDraft(t, sample);
    expect(withWallet.html).toContain('Add to wallet');
    expect(withWallet.html).toContain('attached to this e-mail as PDF');
    expect(withWallet.html).not.toContain('{{');
    expect(withWallet.missing).not.toContain('walletLinks');
    expect(withWallet.html).toContain('Download PDF');
    expect(withWallet.text).toContain('Download PDF:');
    const without = renderTemplateDraft(t, { ...sample, walletLinks: '', ticketLinks: '' });
    expect(without.html).not.toContain('Add to wallet');
    expect(without.text).not.toContain('wallet app');
    expect(without.subject).toBe('Payment received – your order 2026-000123');
  });

  it('says the tickets are not attached when the PDF was left out', () => {
    const shop = { shopName: 'Shop', primaryColor: '#111111', accentColor: '#222222' };
    for (const key of ['PAYMENT_RECEIVED_TICKETS', 'TICKETS_RESENT'] as const) {
      for (const locale of ['en', 'de'] as const) {
        const t = defaultEmailTemplates().find((x) => x.key === key && x.locale === locale)!;
        const sample = sampleEmailVariables(key, locale, shop);
        const attached = renderTemplateDraft(t, sample);
        const omitted = renderTemplateDraft(t, { ...sample, ticketsAttached: '' });
        const claim = locale === 'en' ? 'attached to this e-mail' : 'im Anhang dieser E-Mail';
        expect(attached.html, `${key}/${locale}`).toContain(claim);
        expect(attached.text, `${key}/${locale}`).toContain(claim);
        // The invoice sentence of PAYMENT_RECEIVED_TICKETS mentions the attachment too: check the tickets.
        expect(omitted.html, `${key}/${locale}`).not.toMatch(
          /tickets are attached|Tickets findest du als PDF/,
        );
        expect(omitted.text, `${key}/${locale}`).not.toMatch(
          /tickets are attached|Tickets findest du als PDF/,
        );
        expect(omitted.html).toContain(locale === 'en' ? 'individually' : 'einzeln');
        expect(omitted.html).not.toContain('{{');
      }
    }
  });

  it('protects {{ticketLinks}} as a block-level token in the visual editor', () => {
    const html = '<p>x</p>\n{{#if ticketLinks}}<p>Tickets</p>\n{{ticketLinks}}{{/if}}';
    const out = protectEmailLogic(html);
    expect(out).toContain('<div data-tpl="{{ticketLinks}}"></div>');
    expect(restoreEmailLogic(out)).toBe(html);
  });

  it('escapes values and reports unknown placeholders', () => {
    const out = renderTemplateDraft(
      { subject: 'S', bodyHtml: '<p>{{firstName}} {{nope}}</p>', bodyText: null },
      { firstName: '<b>x</b>' },
    );
    expect(out.html).toBe('<p>&lt;b&gt;x&lt;/b&gt; </p>');
    expect(out.missing).toEqual(['nope']);
  });
});

describe('content region', () => {
  it('finds the default layout card and round-trips with markers', () => {
    const t = defaultEmailTemplates().find(
      (x) => x.key === 'ORDER_CANCELLED' && x.locale === 'de',
    )!;
    const parts = splitEmailContent(t.bodyHtml)!;
    expect(parts.via).toBe('layout');
    expect(parts.content).not.toContain('<html');
    const joined = joinEmailContent(parts, parts.content);
    const again = splitEmailContent(sanitizeEmailHtml(joined))!;
    expect(again.via).toBe('marker');
    expect(again.content.replaceAll(' />', '>')).toBe(parts.content);
  });

  it('treats plain fragments as editable and unknown documents as source-only', () => {
    expect(splitEmailContent('<p>Hi</p>')?.via).toBe('fragment');
    expect(splitEmailContent('<html><body><div>x</div></body></html>')).toBeNull();
  });
});

describe('visual editor logic chips', () => {
  const outsideTextBlocks = (html: string) =>
    html
      .replace(/<div data-tpl="[^"]*"><\/div>/g, '')
      .replace(/<(p|h[1-6]|li)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  it('protects every block-level directive of every default and restores it byte-exact', () => {
    for (const t of defaultEmailTemplates()) {
      const split = splitEmailContent(t.bodyHtml);
      expect(split, `${t.key}/${t.locale}`).not.toBeNull();
      const content = split!.content;
      const protectedHtml = protectEmailLogic(content);
      expect(restoreEmailLogic(protectedHtml), `${t.key}/${t.locale}`).toBe(content);
      // Directives left as plain text may only sit inside running text (paragraphs / headings).
      expect(
        outsideTextBlocks(protectedHtml).match(/\{\{\s*(?:#|\/|else)[^{}]*\}\}/g) ?? [],
        `${t.key}/${t.locale}`,
      ).toEqual([]);
    }
  });

  it('keeps inline directives inside a sentence as text', () => {
    const html = '<p>Hello{{#if firstName}} {{firstName}}{{/if}},</p>\n{{#if x}}<p>a</p>{{/if}}';
    const out = protectEmailLogic(html);
    expect(out).toContain('<p>Hello{{#if firstName}} {{firstName}}{{/if}},</p>');
    expect(out).toContain('<div data-tpl="{{#if x}}"></div><p>a</p><div data-tpl="{{/if}}"></div>');
  });

  it('restores raw style attributes over the browser-normalised ones', () => {
    const raw = 'background:{{accentColor}};color:#fff';
    const html = `<a style="color: rgb(255, 255, 255);" data-tpl-style="${raw}" href="{{orderUrl}}">x</a>`;
    expect(restoreEmailLogic(html)).toBe(`<a style="${raw}" href="{{orderUrl}}">x</a>`);
  });

  it('shows the automatic cancellation date only conditionally', () => {
    for (const t of defaultEmailTemplates()) {
      const mentions = /cancelled automatically|automatisch storniert/.test(
        t.bodyHtml + t.bodyText,
      );
      if (!mentions) continue;
      for (const body of [t.bodyHtml, t.bodyText]) {
        const rest = body.replace(/\{\{#if autoCancelDate\}\}[\s\S]*?\{\{\/if\}\}/g, '');
        expect(body, `${t.key}/${t.locale}`).toContain('{{#if autoCancelDate}}');
        expect(rest, `${t.key}/${t.locale}`).not.toMatch(
          /cancelled automatically|automatisch storniert/,
        );
      }
    }
  });

  it('stacks the bank details instead of using label/value columns', () => {
    for (const t of defaultEmailTemplates()) {
      if (t.key !== 'ORDER_CONFIRMATION_BANK_TRANSFER' && t.key !== 'PAYMENT_REMINDER') continue;
      expect(t.bodyHtml).not.toContain('white-space:nowrap');
      expect(t.bodyHtml).toContain('{{iban}}');
    }
  });
});
