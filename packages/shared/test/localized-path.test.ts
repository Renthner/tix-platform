import { describe, expect, it } from 'vitest';
import { localizedPath } from '../src/i18n';

describe('localizedPath', () => {
  it('default en: English unprefixed, German prefixed', () => {
    expect(localizedPath('en', '/admin/login', 'en')).toBe('/admin/login');
    expect(localizedPath('de', '/admin/login', 'en')).toBe('/de/admin/login');
  });
  it('default de: German unprefixed, English prefixed', () => {
    expect(localizedPath('de', '/admin/login', 'de')).toBe('/admin/login');
    expect(localizedPath('en', '/admin/login', 'de')).toBe('/en/admin/login');
  });
  it('root path', () => {
    expect(localizedPath('en', '/', 'en')).toBe('/');
    expect(localizedPath('de', '/', 'en')).toBe('/de');
    expect(localizedPath('en', '/', 'de')).toBe('/en');
  });
  it('keeps query and hash', () => {
    expect(localizedPath('de', '/orders/1?t=a#x', 'en')).toBe('/de/orders/1?t=a#x');
    expect(localizedPath('de', '/?a=1', 'en')).toBe('/de?a=1');
    expect(localizedPath('de', '/#top', 'en')).toBe('/de#top');
    expect(localizedPath('en', '/orders/1?t=a', 'en')).toBe('/orders/1?t=a');
  });
  it('adds a missing leading slash', () => {
    expect(localizedPath('de', 'cart', 'en')).toBe('/de/cart');
  });
});
