import { describe, expect, it } from 'vitest';
import {
  MEDIA_VARIANT_WIDTHS,
  mediaSrcSetWidths,
  mediaVariantWidths,
  MEDIA_CACHE_IMMUTABLE,
  MEDIA_CACHE_ORIGINAL,
  MEDIA_CACHE_SHORT,
  publicMediaCacheControl,
  parseMediaVariantQuery,
} from '../src';

describe('media variant widths', () => {
  it('never upscales and adds the source width as the top variant', () => {
    expect(mediaVariantWidths(1000)).toEqual([320, 640, 960, 1000]);
    expect(mediaVariantWidths(1280)).toEqual([320, 640, 960, 1280]);
    expect(mediaVariantWidths(200)).toEqual([200]);
    expect(mediaVariantWidths(320)).toEqual([320]);
  });

  it('caps at the widest allow-listed width', () => {
    expect(mediaVariantWidths(6000)).toEqual([...MEDIA_VARIANT_WIDTHS]);
  });

  it('maps srcset candidates to allow-listed URL widths', () => {
    expect(mediaSrcSetWidths(1000)).toEqual([
      { param: 320, descriptor: 320 },
      { param: 640, descriptor: 640 },
      { param: 960, descriptor: 960 },
      { param: 1280, descriptor: 1000 },
    ]);
    for (const c of mediaSrcSetWidths(777)) {
      expect(MEDIA_VARIANT_WIDTHS as readonly number[]).toContain(c.param);
    }
  });
});

describe('parseMediaVariantQuery', () => {
  const parse = (q: string) => parseMediaVariantQuery(new URLSearchParams(q));

  it('returns null without variant parameters (the original)', () => {
    expect(parse('')).toBeNull();
    expect(parse('download=1')).toBeNull();
  });

  it('accepts allow-listed values and defaults the width', () => {
    expect(parse('w=640&f=avif')).toEqual({ format: 'avif', width: 640 });
    expect(parse('f=webp')).toEqual({ format: 'webp', width: 2560 });
  });

  it('rejects everything else', () => {
    for (const q of [
      'w=640',
      'w=641&f=avif',
      'w=640&f=png',
      'w=0&f=avif',
      'w=-320&f=avif',
      'w=640.0&f=avif',
      'w=0x280&f=avif',
      'w=640&f=',
      'f=AVIF',
      'w=&f=webp',
    ]) {
      expect(parse(q), q).toBe('invalid');
    }
  });
});

describe('publicMediaCacheControl', () => {
  const base = { variantRequested: true, requestedWidth: 640, variantsProcessed: true };
  it('lets the original revalidate (its master may be replaced once)', () => {
    expect(publicMediaCacheControl({ ...base, variantRequested: false, variant: null })).toBe(
      MEDIA_CACHE_ORIGINAL,
    );
  });
  it('caches a stand-in briefly while the worker is still converting', () => {
    expect(
      publicMediaCacheControl({
        ...base,
        variantsProcessed: false,
        variant: { width: 640, largestWidth: 1000 },
      }),
    ).toBe(MEDIA_CACHE_SHORT);
    expect(publicMediaCacheControl({ ...base, variant: null })).toBe(MEDIA_CACHE_SHORT);
  });
  it('is immutable for the requested width or the widest one once processed', () => {
    expect(publicMediaCacheControl({ ...base, variant: { width: 640, largestWidth: 1000 } })).toBe(
      MEDIA_CACHE_IMMUTABLE,
    );
    expect(
      publicMediaCacheControl({
        ...base,
        requestedWidth: 1920,
        variant: { width: 1000, largestWidth: 1000 },
      }),
    ).toBe(MEDIA_CACHE_IMMUTABLE);
  });
  it('stays short when a smaller stand-in was chosen for a missing width', () => {
    expect(
      publicMediaCacheControl({
        ...base,
        requestedWidth: 960,
        variant: { width: 1000, largestWidth: 1280 },
      }),
    ).toBe(MEDIA_CACHE_SHORT);
  });
});
