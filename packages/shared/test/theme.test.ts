import { describe, expect, it } from 'vitest';
import { isAdminPath, parseThemeCookie, resolveTheme, themeAreaOf } from '../src';

const visitor = { mode: 'VISITOR_CHOICE', defaultTheme: 'SYSTEM' } as const;

describe('resolveTheme', () => {
  it('visitor choice without cookie renders the default theme', () => {
    expect(resolveTheme({ area: 'shop', config: visitor, cookie: null }).preference).toBe('system');
    const light = resolveTheme({
      area: 'shop',
      config: { mode: 'VISITOR_CHOICE', defaultTheme: 'LIGHT' },
      cookie: null,
    });
    expect(light).toEqual({ preference: 'light', defaultPreference: 'light', fixed: false });
  });

  it('a visitor cookie wins over the default, including an explicit "system"', () => {
    const config = { mode: 'VISITOR_CHOICE', defaultTheme: 'LIGHT' } as const;
    expect(resolveTheme({ area: 'shop', config, cookie: 'dark' }).preference).toBe('dark');
    expect(resolveTheme({ area: 'shop', config, cookie: 'system' }).preference).toBe('system');
  });

  it('a fixed mode ignores the cookie and marks the theme as fixed', () => {
    const dark = resolveTheme({
      area: 'shop',
      config: { mode: 'ALWAYS_DARK', defaultTheme: 'SYSTEM' },
      cookie: 'light',
    });
    expect(dark).toEqual({ preference: 'dark', defaultPreference: 'dark', fixed: true });
    expect(
      resolveTheme({
        area: 'shop',
        config: { mode: 'ALWAYS_LIGHT', defaultTheme: 'DARK' },
        cookie: 'dark',
      }).preference,
    ).toBe('light');
  });

  it('the admin area is never affected by the shop configuration', () => {
    const fixed = { mode: 'ALWAYS_DARK', defaultTheme: 'DARK' } as const;
    expect(resolveTheme({ area: 'admin', config: fixed, cookie: null })).toEqual({
      preference: 'system',
      defaultPreference: 'system',
      fixed: false,
    });
    expect(resolveTheme({ area: 'admin', config: fixed, cookie: 'light' }).preference).toBe(
      'light',
    );
  });
});

describe('theme helpers', () => {
  it('parses cookie values', () => {
    expect(parseThemeCookie('dark')).toBe('dark');
    expect(parseThemeCookie('system')).toBe('system');
    expect(parseThemeCookie('blue')).toBeNull();
    expect(parseThemeCookie(undefined)).toBeNull();
  });

  it('tells shop and admin paths apart (with and without locale prefix)', () => {
    for (const p of ['/admin', '/admin/events', '/de/admin/orders', '/en/admin']) {
      expect(isAdminPath(p), p).toBe(true);
    }
    for (const p of ['/', '/de', '/events/admin', '/administrator', '/de/events']) {
      expect(isAdminPath(p), p).toBe(false);
    }
    expect(themeAreaOf('/de/admin')).toBe('admin');
    expect(themeAreaOf('/cart')).toBe('shop');
  });
});
