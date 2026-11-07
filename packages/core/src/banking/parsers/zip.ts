import { inflateRawSync } from 'node:zlib';
import { StatementParseError } from '../types';

/**
 * Minimal ZIP reader for statement archives (banks often deliver one camt.053 XML per day
 * in a ZIP). Supports stored and deflated entries without encryption; guards against zip
 * bombs with entry count and size limits.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const MAX_ENTRIES = 500;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new StatementParseError('INVALID_ZIP', 'ZIP end of central directory not found');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES)
    throw new StatementParseError('INVALID_ZIP', 'Too many files in the ZIP archive');
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new StatementParseError('INVALID_ZIP', 'Corrupt ZIP central directory');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 0x1)
      throw new StatementParseError('INVALID_ZIP', 'Encrypted ZIP archives are not supported');
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new StatementParseError('INVALID_ZIP', 'Corrupt ZIP local header');
    }
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + compressedSize);
    total += size;
    if (total > MAX_TOTAL_BYTES)
      throw new StatementParseError('INVALID_ZIP', 'ZIP archive too large');
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }));
      } catch {
        throw new StatementParseError('INVALID_ZIP', `Cannot decompress "${name}"`);
      }
    } else {
      throw new StatementParseError('INVALID_ZIP', `Unsupported compression in "${name}"`);
    }
    entries.push({ name, data });
  }
  return entries;
}
