import { BackupCryptoError, ByteReader } from './crypto';

/**
 * Plain container inside the encrypted stream (own framing instead of tar: no path-length
 * limits, entries of unknown size can be streamed, no extra dependency):
 *
 *   entry  = u32be(headerLen) | headerJson | data frames | u32be(0)
 *   data   = u32be(len) | bytes            (len > 0, at most DATA_FRAME_BYTES)
 *   end    = u32be(0) where an entry header would start
 */

const DATA_FRAME_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export interface ArchiveEntryHeader {
  name: string;
  contentType?: string;
  /** Size of the data when known up front (files); informational. */
  size?: number;
}

export interface ArchiveEntry {
  header: ArchiveEntryHeader;
  data: AsyncIterable<Uint8Array>;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};

/** Serialises entries; the data of one entry is fully consumed before the next one is pulled. */
export async function* writeArchive(entries: AsyncIterable<ArchiveEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    const header = Buffer.from(JSON.stringify(entry.header), 'utf8');
    yield u32(header.length);
    yield header;
    for await (const part of entry.data) {
      const buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      for (let offset = 0; offset < buf.length; offset += DATA_FRAME_BYTES) {
        const piece = buf.subarray(offset, offset + DATA_FRAME_BYTES);
        yield u32(piece.length);
        yield piece;
      }
    }
    yield u32(0);
  }
  yield u32(0);
}

export interface ReadArchiveEntry {
  header: ArchiveEntryHeader;
  /** Must be consumed (or ignored – the reader skips the rest) before the next entry is requested. */
  data: AsyncGenerator<Buffer>;
}

export async function* readArchive(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<ReadArchiveEntry> {
  const reader = new ByteReader(source);
  for (;;) {
    const lengthBuf = await reader.readOrEnd(4);
    if (!lengthBuf) throw new BackupCryptoError('BAD_ARCHIVE', 'Archive ends without terminator');
    const headerLength = lengthBuf.readUInt32BE(0);
    if (headerLength === 0) {
      if ((await reader.readOrEnd(1)) !== null) {
        throw new BackupCryptoError('BAD_ARCHIVE', 'Unexpected data after the archive terminator');
      }
      return;
    }
    if (headerLength > MAX_HEADER_BYTES) {
      throw new BackupCryptoError('BAD_ARCHIVE', 'Invalid entry header');
    }
    let header: ArchiveEntryHeader;
    try {
      header = JSON.parse((await reader.read(headerLength)).toString('utf8')) as ArchiveEntryHeader;
    } catch (err) {
      if (err instanceof BackupCryptoError) throw err;
      throw new BackupCryptoError('BAD_ARCHIVE', 'Invalid entry header');
    }
    if (typeof header.name !== 'string' || header.name.length === 0) {
      throw new BackupCryptoError('BAD_ARCHIVE', 'Entry without a name');
    }
    let finished = false;
    const nextFrame = async (): Promise<Buffer | null> => {
      if (finished) return null;
      const len = (await reader.read(4)).readUInt32BE(0);
      if (len === 0) {
        finished = true;
        return null;
      }
      if (len > DATA_FRAME_BYTES) throw new BackupCryptoError('BAD_ARCHIVE', 'Invalid frame');
      return reader.read(len);
    };
    async function* data(): AsyncGenerator<Buffer> {
      for (let frame = await nextFrame(); frame; frame = await nextFrame()) yield frame;
    }
    yield { header, data: data() };
    // Skip whatever the consumer left unread (also when it stopped early).
    while (await nextFrame()) {
      /* discard */
    }
  }
}

/** Collects a small entry (manifest) into memory. */
export async function collect(
  data: AsyncIterable<Uint8Array>,
  maxBytes = 5_000_000,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of data) {
    total += part.byteLength;
    if (total > maxBytes) throw new BackupCryptoError('BAD_ARCHIVE', 'Entry too large');
    parts.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
  }
  return Buffer.concat(parts);
}
