import { deflateSync } from 'node:zlib';
import qrcode from 'qrcode-generator';
import { epcQrData } from './epc-qr';

/**
 * Minimal PNG encoder for QR codes (1-bit greyscale, no external image library): e-mail clients
 * need a raster image for inline (CID) pictures, and `sharp` is not available in every process
 * that sends mail. Node only (zlib).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG of a square module matrix: `isDark(row, col)` for `count` × `count` modules, each drawn as
 * `scale` × `scale` pixels, surrounded by a white quiet zone of `margin` modules.
 */
export function moduleMatrixPng(
  count: number,
  isDark: (row: number, col: number) => boolean,
  options: { scale?: number; margin?: number } = {},
): Uint8Array {
  const scale = options.scale ?? 6;
  const margin = options.margin ?? 4;
  const size = (count + 2 * margin) * scale;
  const rowBytes = Math.ceil(size / 8);
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    const offset = y * (rowBytes + 1); // first byte: filter type 0 (none)
    const row = Math.floor(y / scale) - margin;
    for (let x = 0; x < size; x++) {
      const col = Math.floor(x / scale) - margin;
      const dark = row >= 0 && row < count && col >= 0 && col < count && isDark(row, col);
      // Greyscale bit depth 1: 1 = white, 0 = black.
      if (!dark) raw[offset + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // colour type: greyscale
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // no interlace
  return new Uint8Array(
    Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

/** PNG of the EPC QR code of `payload` (error correction M, quiet zone 4 modules). */
export function epcQrPng(payload: string, options: { scale?: number } = {}): Uint8Array {
  const code = qrcode(0, 'M');
  code.addData(epcQrData(payload), 'Byte');
  code.make();
  return moduleMatrixPng(code.getModuleCount(), (r, c) => code.isDark(r, c), {
    scale: options.scale,
    margin: 4,
  });
}
