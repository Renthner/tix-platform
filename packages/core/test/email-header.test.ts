import { defaultEmailTemplates } from '@tix/db';
import { describe, expect, it } from 'vitest';
import {
  buildShopHeader,
  EMAIL_LOGO_MAX_HEIGHT,
  EMAIL_LOGO_MAX_WIDTH,
  EMAIL_VARIABLES,
  emailLogoSize,
  renderTemplate,
} from '../src';

const logo = { url: 'https://shop.example.org/api/media/abc', width: 80, height: 36 };

describe('e-mail header band', () => {
  it('without a logo it is the escaped shop name, exactly as before', () => {
    const header = buildShopHeader({ shopName: 'A & B <Tickets>', foreground: '#fff', logo: null });
    expect(header.html).toBe('A &amp; B &lt;Tickets&gt;');
    expect(header.text).toBe('A & B <Tickets>');
  });

  it('with a logo: table layout, explicit size, absolute URL, alt text, visible title', () => {
    const { html } = buildShopHeader({ shopName: 'Shop', foreground: '#0a0a0a', logo });
    expect(html).toContain('src="https://shop.example.org/api/media/abc"');
    expect(html).toContain('width="80" height="36" alt="Shop"');
    expect(html).toContain('display:block');
    expect(html).toContain('color:#0a0a0a;font-size:20px;font-weight:700');
    expect(html).toContain('>Shop</td>');
    expect(html).not.toMatch(/flex|base64/i);
  });

  it('escapes the title, alt text and URL', () => {
    const { html } = buildShopHeader({
      shopName: '"><script>x</script>',
      foreground: '#fff',
      logo: { ...logo, url: 'https://x.example/a?b="c"&d=<e>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('alt="&quot;&gt;&lt;script&gt;');
    expect(html).toContain('src="https://x.example/a?b=&quot;c&quot;&amp;d=&lt;e&gt;"');
  });

  it('sizes the logo within the height and width limits, keeping the aspect ratio', () => {
    expect(emailLogoSize(96, { width: 200, height: 100 })).toEqual({
      width: EMAIL_LOGO_MAX_HEIGHT * 2,
      height: EMAIL_LOGO_MAX_HEIGHT,
    });
    expect(emailLogoSize(36, { width: 1000, height: 100 })).toEqual({
      width: EMAIL_LOGO_MAX_WIDTH,
      height: 16,
    });
    expect(emailLogoSize(4, { width: 10, height: 10 }).height).toBe(16);
    expect(emailLogoSize(30, { width: null, height: null })).toEqual({ width: null, height: 30 });
  });

  it('an explicit e-mail logo height (16-64 px) wins over the shop-header height', () => {
    expect(emailLogoSize(36, { width: 100, height: 100 }, 56)).toEqual({ width: 56, height: 56 });
    expect(emailLogoSize(36, { width: 100, height: 100 }, 200).height).toBe(64);
    expect(emailLogoSize(36, { width: 100, height: 100 }, 2).height).toBe(16);
    expect(emailLogoSize(36, { width: 1000, height: 100 }, 64)).toEqual({ width: 160, height: 16 });
    expect(emailLogoSize(90, { width: 100, height: 100 }, null).height).toBe(EMAIL_LOGO_MAX_HEIGHT);
  });

  it('every default template renders the header through {{shopHeader}}', () => {
    expect(EMAIL_VARIABLES.shop).toContain('shopHeader');
    const header = buildShopHeader({ shopName: 'Shop', foreground: '#fff', logo });
    for (const t of defaultEmailTemplates()) {
      expect(t.bodyHtml, `${t.key}/${t.locale}`).toContain('{{shopHeader}}</td></tr>');
      const out = renderTemplate(
        t.bodyHtml,
        { shopName: 'Shop', shopHeader: header },
        'html',
      ).output;
      expect(out).toContain('src="https://shop.example.org/api/media/abc"');
    }
  });
});
