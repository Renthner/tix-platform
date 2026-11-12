import { describe, expect, it } from 'vitest';
import {
  SETTINGS,
  START_PAGE_HTML_MAX,
  START_PAGE_MAX_GALLERY,
  resolveStartPageTexts,
} from '../src';

const schema = SETTINGS.startPage.schema;
const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe('startPage setting', () => {
  it('defaults to an empty page', () => {
    expect(schema.parse({})).toEqual({
      mode: 'BUILDER',
      layout: 'ABOVE',
      galleryAssetIds: [],
      texts: {},
    });
  });

  it('accepts https and shop-relative button links only', () => {
    for (const ok of ['https://example.org/a?b=1', '/account', '/events/x'])
      expect(schema.safeParse({ buttonUrl: ok }).success, ok).toBe(true);
    for (const bad of [
      'http://example.org',
      'javascript:alert(1)',
      '//evil.example',
      'example.org',
      '/a b',
      '/\\evil.example',
      'data:text/html,x',
    ])
      expect(schema.safeParse({ buttonUrl: bad }).success, bad).toBe(false);
  });

  it('allows at most four gallery images and only UUIDs', () => {
    const ids = Array.from({ length: START_PAGE_MAX_GALLERY }, (_, i) => uuid(i));
    expect(schema.safeParse({ galleryAssetIds: ids }).success).toBe(true);
    expect(schema.safeParse({ galleryAssetIds: [...ids, uuid(9)] }).success).toBe(false);
    expect(schema.safeParse({ galleryAssetIds: ['nope'] }).success).toBe(false);
    expect(schema.safeParse({ heroAssetId: 'nope' }).success).toBe(false);
  });

  it('rejects unknown layouts and locales', () => {
    expect(schema.safeParse({ layout: 'GRID' }).success).toBe(false);
    expect(schema.safeParse({ texts: { fr: { headline: 'x' } } }).success).toBe(false);
  });

  it('accepts the HTML mode and limits the custom HTML size', () => {
    expect(schema.safeParse({ mode: 'HTML' }).success).toBe(true);
    expect(schema.safeParse({ mode: 'WYSIWYG' }).success).toBe(false);
    const ok = 'x'.repeat(START_PAGE_HTML_MAX);
    expect(schema.safeParse({ texts: { en: { html: ok } } }).success).toBe(true);
    expect(schema.safeParse({ texts: { en: { html: ok + 'x' } } }).success).toBe(false);
  });

  it('limits text lengths', () => {
    expect(schema.safeParse({ texts: { en: { headline: 'x'.repeat(201) } } }).success).toBe(false);
  });
});

describe('resolveStartPageTexts', () => {
  const settings = schema.parse({
    galleryAssetIds: [uuid(1), uuid(2)],
    texts: {
      en: { headline: 'Hello', body: '<p>EN</p>', galleryAlt: ['one', 'two'] },
      de: { headline: 'Hallo', galleryAlt: ['', 'zwei'] },
    },
  });

  it('uses the requested locale and falls back per field to the default locale', () => {
    const de = resolveStartPageTexts(settings, 'de', 'en');
    expect(de.headline).toBe('Hallo');
    expect(de.body).toBe('<p>EN</p>');
    expect(de.galleryAlt).toEqual(['one', 'zwei']);
  });

  it('returns nothing when nothing is configured', () => {
    const r = resolveStartPageTexts(schema.parse({}), 'de', 'en');
    expect(r.headline).toBeUndefined();
    expect(r.heroAlt).toBe('');
  });
});
