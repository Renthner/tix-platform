import { parseSetting } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import { buildShopHeader } from '../src';

const logo = { url: 'https://shop.example.org/api/media/abc', width: 80, height: 36 };
const base = { shopName: 'Shop', foreground: '#ffffff', logo };
const render = (options: Parameters<typeof buildShopHeader>[0]['options']) =>
  buildShopHeader({ ...base, options }).html;

describe('e-mail header options', () => {
  it('defaults to the logo directly on the colour, no box, no background', () => {
    const html = render(undefined);
    expect(html).toContain('<img ');
    expect(html).not.toMatch(/background|bgcolor|border-radius/);
    expect(html).toContain('>Shop</td>');
    expect(html).toBe(render(parseSetting('emailHeader', {})));
  });

  it('DIRECT puts no box around the logo, whatever the chip fields say', () => {
    const html = render({ logoDisplay: 'DIRECT', chipColor: '#123456', chipCorners: 'ROUNDED' });
    expect(html).not.toMatch(/background|bgcolor|border-radius|#123456/);
  });

  it('CHIP uses the configured colour, corners and padding', () => {
    const rounded = render({
      logoDisplay: 'CHIP',
      chipColor: '#abc',
      chipCorners: 'ROUNDED',
      chipPadding: 'SMALL',
    });
    expect(rounded).toContain('background:#abc;border-radius:6px;padding:4px');
    expect(rounded).toContain('bgcolor="#abc"');
    const square = render({
      logoDisplay: 'CHIP',
      chipColor: '#112233',
      chipCorners: 'SQUARE',
      chipPadding: 'MEDIUM',
    });
    expect(square).toContain('background:#112233;border-radius:0px;padding:8px');
  });

  it('never lets an invalid chip colour into the markup', () => {
    for (const evil of ['red;background:url(x)', '"><script>x</script>', '#12', 'javascript:1']) {
      const html = render({ logoDisplay: 'CHIP', chipColor: evil });
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('url(x)');
      expect(html).not.toContain(evil);
      expect(html).toContain('background:#ffffff;');
    }
  });

  it('NONE and TITLE_ONLY show the escaped title only', () => {
    const none = buildShopHeader({
      shopName: 'A & B',
      foreground: '#fff',
      logo,
      options: { logoDisplay: 'NONE' },
    });
    expect(none.html).toBe('A &amp; B');
    const titleOnly = buildShopHeader({
      shopName: 'A & B',
      foreground: '#fff',
      logo,
      options: { layout: 'TITLE_ONLY' },
    });
    expect(titleOnly.html).toBe('A &amp; B');
    expect(titleOnly.text).toBe('A & B');
  });

  it('LOGO_ONLY carries the name as alt text only; no logo falls back to the title', () => {
    const html = render({ layout: 'LOGO_ONLY' });
    expect(html).toContain('alt="Shop"');
    expect(html).not.toContain('>Shop<');
    const noLogo = buildShopHeader({ ...base, logo: null, options: { layout: 'LOGO_ONLY' } });
    expect(noLogo.html).toBe('Shop');
  });

  it('LOGO_ABOVE_TITLE_CENTERED stacks logo over a centred title', () => {
    const html = render({ layout: 'LOGO_ABOVE_TITLE_CENTERED', logoDisplay: 'CHIP' });
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('>Shop</td>'));
    expect(html).toContain('align="center"');
    expect(html).toContain('text-align:center');
    expect(html).toContain('color:#ffffff;font-size:20px');
    expect(html).not.toMatch(/flex/i);
  });

  it('centres the left/right layout and the title-only text on request', () => {
    expect(render({ align: 'CENTER' })).toContain('align="center"');
    const titleOnly = buildShopHeader({
      ...base,
      logo: null,
      options: { align: 'CENTER' },
    }).html;
    expect(titleOnly).toContain('text-align:center');
    expect(titleOnly).toContain('>Shop</td>');
    expect(render({ align: 'LEFT' })).not.toContain('align="center"');
  });

  it('keeps explicit size, absolute URL and a table based layout in every layout', () => {
    for (const layout of [
      'LOGO_LEFT_TITLE_RIGHT',
      'LOGO_ONLY',
      'LOGO_ABOVE_TITLE_CENTERED',
    ] as const) {
      const html = render({ layout });
      expect(html).toContain('src="https://shop.example.org/api/media/abc"');
      expect(html).toContain('width="80" height="36"');
      expect(html).toContain('role="presentation"');
    }
  });
});

describe('emailHeader setting schema', () => {
  it('has complete defaults (existing installs without a stored value)', () => {
    expect(parseSetting('emailHeader', {})).toEqual({
      logoDisplay: 'DIRECT',
      layout: 'LOGO_LEFT_TITLE_RIGHT',
      align: 'LEFT',
      logoHeight: null,
      chipColor: '#ffffff',
      chipCorners: 'ROUNDED',
      chipPadding: 'MEDIUM',
    });
  });
});
