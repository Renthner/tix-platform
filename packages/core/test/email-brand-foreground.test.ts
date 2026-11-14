import { defaultEmailTemplates } from '@tix/db';
import { foregroundOn } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import { EMAIL_VARIABLES, renderTemplate } from '../src';

/** Shop variables as `shopVariables` derives them from the brand colour. */
const shop = (brand: string) => ({
  shopName: 'Shop',
  brandColor: brand,
  brandForegroundColor: foregroundOn(brand),
  primaryColor: brand,
  accentColor: brand,
  orderUrl: 'https://shop.example.org/orders/1',
  verificationUrl: 'https://shop.example.org/verify',
});

describe('e-mail text colour on the brand colour', () => {
  it('offers {{brandForegroundColor}} as a shop variable', () => {
    expect(EMAIL_VARIABLES.shop).toContain('brandForegroundColor');
  });

  it('default buttons and banner use it instead of a fixed white', () => {
    for (const t of defaultEmailTemplates()) {
      expect(t.bodyHtml, `${t.key}/${t.locale}`).not.toMatch(
        /background:\{\{(?:accent|primary)Color\}\}[^"]*color:#fff/i,
      );
      expect(t.bodyHtml).toContain('color:{{brandForegroundColor}}');
    }
  });

  it('a light brand colour renders dark button text, a dark one white text', () => {
    const template = defaultEmailTemplates().find(
      (t) => t.key === 'ORDER_CONFIRMATION_BANK_TRANSFER' && t.locale === 'en',
    )!;
    const light = renderTemplate(template.bodyHtml, shop('#FDE047'), 'html').output;
    expect(light).toContain('background:#FDE047;color:#0a0a0a');
    expect(light).toContain('padding:20px 28px;color:#0a0a0a');
    const dark = renderTemplate(template.bodyHtml, shop('#1E3A8A'), 'html').output;
    expect(dark).toContain('background:#1E3A8A;color:#ffffff');
  });
});
