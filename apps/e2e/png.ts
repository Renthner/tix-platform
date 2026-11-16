import { crc32, deflateSync } from 'node:zlib';

/** A real RGB gradient PNG (no image library needed in the test runner). */
export function gradientPng(width: number, height: number, seed = 0): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const o = y * row;
    raw[o] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o + 1 + x * 3] = Math.floor((x / width) * 255);
      raw[o + 2 + x * 3] = Math.floor((y / height) * 255);
      raw[o + 3 + x * 3] = (x * 7 + y * 3 + seed * 90) & 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
