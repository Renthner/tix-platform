import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TITLE_TEMPLATE,
  SETTINGS,
  applyTitleTemplate,
  expandTitleTemplate,
  isValidTitleTemplate,
  resolveSeoDescription,
  resolveSiteTitle,
} from '../src';

const schema = SETTINGS.seo.schema;

describe('title template', () => {
  it('needs the page title token exactly once', () => {
    expect(isValidTitleTemplate('%s')).toBe(true);
    expect(isValidTitleTemplate('%s | {siteTitle}')).toBe(true);
    expect(isValidTitleTemplate('{siteTitle}')).toBe(false);
    expect(isValidTitleTemplate('%s – %s')).toBe(false);
    expect(isValidTitleTemplate('')).toBe(false);
  });

  it('fills in the site title and the page title literally', () => {
    expect(expandTitleTemplate('%s | {siteTitle}', 'Club')).toBe('%s | Club');
    expect(applyTitleTemplate(DEFAULT_TITLE_TEMPLATE, 'Concert', 'Club')).toBe('Concert · Club');
    // "$&" must not be interpreted as a replacement pattern.
    expect(applyTitleTemplate('%s | {siteTitle}', 'A $& B', 'C $1')).toBe('A $& B | C $1');
  });
});

describe('seo setting', () => {
  it('defaults to indexable with the standard template', () => {
    expect(schema.parse({})).toEqual({
      indexing: true,
      titleTemplate: DEFAULT_TITLE_TEMPLATE,
      verification: {},
      texts: {},
    });
  });

  it('rejects invalid templates, handles and tokens', () => {
    expect(schema.safeParse({ titleTemplate: 'no token' }).success).toBe(false);
    expect(schema.safeParse({ titleTemplate: '%s %s' }).success).toBe(false);
    expect(schema.safeParse({ twitterHandle: '@verein_1' }).success).toBe(true);
    for (const bad of ['verein', '@', '@a b', '@waytoolongtwitterhandle'])
      expect(schema.safeParse({ twitterHandle: bad }).success, bad).toBe(false);
    expect(schema.safeParse({ verification: { google: 'abc_DEF-123456' } }).success).toBe(true);
    expect(schema.safeParse({ verification: { google: '"><script>' } }).success).toBe(false);
  });

  it('limits the description to 300 characters', () => {
    expect(schema.safeParse({ texts: { en: { description: 'x'.repeat(300) } } }).success).toBe(
      true,
    );
    expect(schema.safeParse({ texts: { en: { description: 'x'.repeat(301) } } }).success).toBe(
      false,
    );
  });

  it('falls back from the locale to the default locale to the shop name', () => {
    const seo = schema.parse({
      texts: { de: { siteTitle: 'Verein', description: 'Beschreibung' } },
    });
    expect(resolveSiteTitle(seo, 'de', 'de', 'Shop')).toBe('Verein');
    expect(resolveSiteTitle(seo, 'en', 'de', 'Shop')).toBe('Verein');
    expect(resolveSiteTitle(seo, 'en', 'en', 'Shop')).toBe('Shop');
    expect(resolveSeoDescription(seo, 'en', 'de')).toBe('Beschreibung');
    expect(resolveSeoDescription(seo, 'en', 'en')).toBeUndefined();
  });
});
