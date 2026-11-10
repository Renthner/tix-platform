import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Streaming authenticated encryption of backup archives (STREAM construction on AES-256-GCM).
 *
 *   header  = "TIXBAK1\n" | keyIdLen(1) | keyId | salt(16) | noncePrefix(4)          (plaintext)
 *   frame   = u32be(final<<31 | ciphertextLen) | ciphertext | tag(16)
 *   nonce   = noncePrefix | u64be(chunkIndex)
 *   AAD     = header | u64be(chunkIndex) | finalFlag
 *
 * The file key is derived with HKDF-SHA256 (random salt per archive) from a key of the
 * `APP_ENCRYPTION_KEYS` ring; the key id is stored in the header, so rotated rings still
 * decrypt old archives. The chunk index (nonce + AAD) detects reordering, the final flag
 * detects truncation at a chunk boundary, the tags detect any bit flip. Memory use is one
 * chunk, independent of the archive size.
 */

export const BACKUP_MAGIC = Buffer.from('TIXBAK1\n', 'latin1');
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const PREFIX_BYTES = 4;
const HKDF_INFO = 'tix-backup-v1';
const FINAL_BIT = 0x8000_0000;

export type BackupCryptoErrorCode =
  'NOT_A_BACKUP' | 'KEY_UNKNOWN' | 'CORRUPT' | 'TRUNCATED' | 'BAD_ARCHIVE';

export class BackupCryptoError extends Error {
  override name = 'BackupCryptoError';
  constructor(
    readonly code: BackupCryptoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BackupKey {
  id: string;
  key: Buffer;
}

/** Pull-based exact reads on top of an async byte stream. */
export class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.length < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const buf = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      if (buf.length > 0) {
        this.chunks.push(buf);
        this.length += buf.length;
      }
    }
  }

  /** Exactly `n` bytes, or null when the stream ended before the first byte; throws on a short read. */
  async readOrEnd(n: number): Promise<Buffer | null> {
    if (n === 0) return Buffer.alloc(0);
    await this.fill(n);
    if (this.length === 0) return null;
    if (this.length < n) throw new BackupCryptoError('TRUNCATED', 'The backup file is truncated');
    const joined = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const head = joined.subarray(0, n);
    const rest = joined.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return head;
  }

  async read(n: number): Promise<Buffer> {
    const buf = await this.readOrEnd(n);
    if (!buf) throw new BackupCryptoError('TRUNCATED', 'The backup file is truncated');
    return buf;
  }

  /** Up to `max` bytes (whatever is buffered / next arrives); null at the end. */
  async readSome(max: number): Promise<Buffer | null> {
    await this.fill(1);
    if (this.length === 0) return null;
    const joined = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const head = joined.subarray(0, max);
    const rest = joined.subarray(head.length);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return head;
  }
}

const deriveKey = (key: Buffer, salt: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', key, salt, HKDF_INFO, 32));

function chunkNonce(prefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(index), PREFIX_BYTES);
  return nonce;
}

function chunkAad(header: Buffer, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(index), 0);
  tail[8] = final ? 1 : 0;
  return Buffer.concat([header, tail]);
}

/** Encrypts a byte stream with the (active) key; yields header and frames. */
export async function* encryptStream(
  source: AsyncIterable<Uint8Array>,
  active: BackupKey,
  chunkBytes = BACKUP_CHUNK_BYTES,
): AsyncGenerator<Buffer> {
  const keyId = Buffer.from(active.id, 'utf8');
  const salt = randomBytes(SALT_BYTES);
  const prefix = randomBytes(PREFIX_BYTES);
  const header = Buffer.concat([BACKUP_MAGIC, Buffer.from([keyId.length]), keyId, salt, prefix]);
  const fileKey = deriveKey(active.key, salt);
  yield header;

  let index = 0;
  const seal = (plain: Buffer, final: boolean): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', fileKey, chunkNonce(prefix, index));
    cipher.setAAD(chunkAad(header, index, final));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const frame = Buffer.alloc(4);
    frame.writeUInt32BE(((final ? FINAL_BIT : 0) | ciphertext.length) >>> 0, 0);
    index += 1;
    return Buffer.concat([frame, ciphertext, cipher.getAuthTag()]);
  };

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const part of source) {
    const buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
    pending.push(buf);
    pendingBytes += buf.length;
    // Keep one chunk back: the last chunk must carry the final flag.
    while (pendingBytes > chunkBytes) {
      const joined = Buffer.concat(pending);
      yield seal(joined.subarray(0, chunkBytes), false);
      const rest = joined.subarray(chunkBytes);
      pending = rest.length > 0 ? [rest] : [];
      pendingBytes = rest.length;
    }
  }
  yield seal(Buffer.concat(pending), true);
}

/** Decrypts a stream produced by `encryptStream`; throws `BackupCryptoError` on any tampering. */
export async function* decryptStream(
  source: AsyncIterable<Uint8Array>,
  ring: readonly BackupKey[],
): AsyncGenerator<Buffer> {
  const reader = new ByteReader(source);
  const magic = await reader.readOrEnd(BACKUP_MAGIC.length).catch(() => null);
  if (!magic || !magic.equals(BACKUP_MAGIC)) {
    throw new BackupCryptoError('NOT_A_BACKUP', 'This file is not a backup archive');
  }
  const idLength = (await reader.read(1))[0]!;
  const keyId = (await reader.read(idLength)).toString('utf8');
  const salt = await reader.read(SALT_BYTES);
  const prefix = await reader.read(PREFIX_BYTES);
  const header = Buffer.concat([
    BACKUP_MAGIC,
    Buffer.from([idLength]),
    Buffer.from(keyId),
    salt,
    prefix,
  ]);
  const key = ring.find((k) => k.id === keyId);
  if (!key) {
    throw new BackupCryptoError(
      'KEY_UNKNOWN',
      `The archive was encrypted with key "${keyId}", which is not in APP_ENCRYPTION_KEYS`,
    );
  }
  const fileKey = deriveKey(key.key, salt);

  for (let index = 0; ; index += 1) {
    const head = await reader.readOrEnd(4);
    if (!head) throw new BackupCryptoError('TRUNCATED', 'The backup file is truncated');
    const word = head.readUInt32BE(0);
    const final = (word & FINAL_BIT) !== 0;
    const length = word & ~FINAL_BIT;
    if (length > BACKUP_CHUNK_BYTES) throw new BackupCryptoError('CORRUPT', 'Invalid chunk size');
    const body = await reader.read(length + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', fileKey, chunkNonce(prefix, index));
    decipher.setAAD(chunkAad(header, index, final));
    decipher.setAuthTag(body.subarray(length));
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]);
    } catch {
      throw new BackupCryptoError(
        'CORRUPT',
        'The backup is corrupt or was modified (authentication failed)',
      );
    }
    yield plain;
    if (final) {
      if ((await reader.readOrEnd(1)) !== null) {
        throw new BackupCryptoError('CORRUPT', 'Unexpected data after the end of the backup');
      }
      return;
    }
  }
}
