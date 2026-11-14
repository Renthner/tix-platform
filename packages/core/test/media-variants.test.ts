import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/context';
import { detectImage } from '../src/media';
import { normaliseUpload, variantStorageKey } from '../src/media-variants';
import { solidPng } from './image-fixtures';

async function normalise(bytes: Uint8Array) {
  const info = detectImage(bytes);
  if (!info) throw new Error('not an image');
  return normaliseUpload(bytes, info);
}

const gps = {
  IFD0: { Make: 'TestCam' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '48/1 8/1 0/1',
    GPSLongitudeRef: 'E',
    GPSLongitude: '11/1 34/1 0/1',
  },
};

describe('normaliseUpload', () => {
  it('keeps clean uploads byte for byte', async () => {
    const png = await solidPng(300, 200, 3);
    const out = await normalise(png);
    expect(out.bytes).toBe(png);
    expect(out).toMatchObject({ mime: 'image/png', ext: 'png', width: 300, height: 200 });
  });

  it('applies the EXIF orientation and strips all metadata (JPEG)', async () => {
    const jpeg = await sharp({
      create: { width: 400, height: 200, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withExif(gps)
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = await sharp(jpeg).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);

    const out = await normalise(new Uint8Array(jpeg));
    expect(out).toMatchObject({ mime: 'image/jpeg', ext: 'jpg', width: 200, height: 400 });
    const after = await sharp(out.bytes).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect([after.width, after.height]).toEqual([200, 400]);
  });

  it('keeps PNG as PNG (alpha preserved) and strips metadata', async () => {
    const png = await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0.5 },
      },
    })
      .png()
      .withExif(gps)
      .toBuffer();
    const out = await normalise(new Uint8Array(png));
    expect(out.mime).toBe('image/png');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.hasAlpha).toBe(true);
  });

  it('turns opaque WebP with metadata into JPEG and transparent WebP into PNG', async () => {
    const opaque = await sharp({
      create: { width: 100, height: 60, channels: 3, background: '#abcdef' },
    })
      .webp()
      .withExif(gps)
      .toBuffer();
    expect((await normalise(new Uint8Array(opaque))).mime).toBe('image/jpeg');
    const transparent = await sharp({
      create: { width: 100, height: 60, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.3 } },
    })
      .webp()
      .withExif(gps)
      .toBuffer();
    expect((await normalise(new Uint8Array(transparent))).mime).toBe('image/png');
  });

  it('always converts clean WebP uploads to JPEG (opaque) or PNG (transparent)', async () => {
    const opaque = await sharp({
      create: { width: 90, height: 50, channels: 3, background: '#123456' },
    })
      .webp()
      .toBuffer();
    const jpeg = await normalise(new Uint8Array(opaque));
    expect(jpeg).toMatchObject({ mime: 'image/jpeg', ext: 'jpg', width: 90, height: 50 });
    expect((await sharp(jpeg.bytes).metadata()).format).toBe('jpeg');
    const transparent = await sharp({
      create: { width: 90, height: 50, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.2 } },
    })
      .webp()
      .toBuffer();
    const png = await normalise(new Uint8Array(transparent));
    expect(png).toMatchObject({ mime: 'image/png', ext: 'png' });
    expect((await sharp(png.bytes).metadata()).hasAlpha).toBe(true);
  });

  it('rejects files that have an image header but do not decode', async () => {
    const png = await solidPng(600, 600, 9);
    const truncated = png.subarray(0, 60);
    const err = await normalise(truncated).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('MEDIA_UNDECODABLE');
  });
});

describe('variantStorageKey', () => {
  it('sits next to the original without its extension', () => {
    expect(variantStorageKey('media/event_image/2026/ab-12.jpg', 'avif', 640)).toBe(
      'media/event_image/2026/ab-12.w640.avif',
    );
    expect(variantStorageKey('media/x.dir/noext', 'webp', 320)).toBe('media/x.dir/noext.w320.webp');
  });
});
