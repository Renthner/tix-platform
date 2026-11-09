import { describe, expect, it } from 'vitest';
import { detectImage } from '../src';

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

/** JPEG with an APP0 segment first, then the frame header (SOF0 or progressive SOF2). */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const frame = [0xff, sof, 0x00, 0x0b, 8, height >> 8, height & 255, width >> 8, width & 255, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...frame, 1, 0x11, 0, 0xff, 0xd9]);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function webpLossy(width: number, height: number): Uint8Array {
  return new Uint8Array([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8 '),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    width & 255,
    width >> 8,
    height & 255,
    height >> 8,
  ]);
}

function webpLossless(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return new Uint8Array([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8L'),
    0,
    0,
    0,
    0,
    0x2f,
    w & 255,
    ((w >> 8) & 0x3f) | ((h & 3) << 6),
    (h >> 2) & 255,
    (h >> 10) & 0x0f,
    0,
    0,
  ]);
}

function webpExtended(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return new Uint8Array([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8X'),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    w & 255,
    (w >> 8) & 255,
    w >> 16,
    h & 255,
    (h >> 8) & 255,
    h >> 16,
  ]);
}

describe('image detection', () => {
  it('reads PNG dimensions', () => {
    expect(detectImage(png(1600, 900))).toEqual({
      mime: 'image/png',
      ext: 'png',
      width: 1600,
      height: 900,
    });
  });

  it('reads JPEG dimensions behind other segments, baseline and progressive', () => {
    expect(detectImage(jpeg(1920, 1080))).toMatchObject({
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
    });
    expect(detectImage(jpeg(640, 480, 0xc2))).toMatchObject({ width: 640, height: 480 });
  });

  it('reads all three WebP flavours', () => {
    expect(detectImage(webpLossy(800, 600))).toMatchObject({
      mime: 'image/webp',
      width: 800,
      height: 600,
    });
    expect(detectImage(webpLossless(1234, 987))).toMatchObject({ width: 1234, height: 987 });
    expect(detectImage(webpExtended(4000, 3000))).toMatchObject({ width: 4000, height: 3000 });
  });

  it('rejects other types, spoofed content and truncated headers', () => {
    const text = new TextEncoder();
    expect(detectImage(text.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(
      detectImage(text.encode('GIF89a-and-some-more-bytes-to-pass-the-length-check')),
    ).toBeNull();
    expect(detectImage(text.encode('%PDF-1.7 hello world, not an image at all.....'))).toBeNull();
    expect(detectImage(png(10, 10).subarray(0, 20))).toBeNull();
    expect(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();
    expect(detectImage(new Uint8Array(0))).toBeNull();
  });
});
