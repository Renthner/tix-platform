import { randomBytes } from 'node:crypto';
import {
  formatKeyRingText,
  mergeKeyRings,
  parseKeyRingText,
  SecretBoxError,
  type SecretBoxKey,
} from '@tix/shared/server';
import { requireCapability, type CoreContext } from '../context';
import { BackupCryptoError, decryptStream } from './crypto';
import type { BackupBucket } from './bucket';
import { archiveKeys, type BackupRuntime } from './runtime';

/**
 * Encryption key(s) of the SOURCE system of a backup (`APP_ENCRYPTION_KEYS` ring entries of the
 * system that made it). The admin pastes them in the web UI; they are used only for the one
 * operation that needs them:
 *
 *  - web  `stageSourceKeys`: validates them, encrypts them with the CURRENT key (secret box) and
 *         parks them in Redis for a limited time, returning an opaque token;
 *  - jobs carry only that token; the worker `takeSourceKeys` consumes it once (GETDEL);
 *  - a restore persists the keys as additional decrypt-only keys (`persistExtraKeys`).
 *
 * The key text is never logged, never part of job data / audit / error messages.
 */

export type SourceKeysErrorCode = 'INVALID' | 'EXPIRED' | 'DISABLED';

/**
 * Operator opt-in. Restoring/probing a backup streams `pg_restore` output into psql as the
 * database user (a superuser in the stock image): whoever can build an archive under a key the
 * system accepts can therefore run arbitrary SQL there (COPY ... TO PROGRAM). With the system's
 * own keys that is only possible for someone who already holds them; entering the keys of
 * ANOTHER system lets a SUPER_ADMIN supply their own. Hence off unless the operator enables it.
 */
export const FOREIGN_BACKUP_KEYS_ENV = 'TIX_ALLOW_FOREIGN_BACKUP_KEYS';

export function foreignBackupKeysAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env[FOREIGN_BACKUP_KEYS_ENV]?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Throws SourceKeysError('DISABLED') unless the operator enabled foreign backup keys. */
export function assertForeignBackupKeysAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!foreignBackupKeysAllowed(env)) {
    throw new SourceKeysError(
      'DISABLED',
      `Keys of another system are disabled (set ${FOREIGN_BACKUP_KEYS_ENV}=1 to allow them)`,
    );
  }
}

export class SourceKeysError extends Error {
  override name = 'SourceKeysError';
  constructor(
    readonly code: SourceKeysErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Long enough for a large upload plus the queue wait; the token is single use. */
export const SOURCE_KEYS_TTL_SECONDS = 3_600;
export const SOURCE_KEYS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SECRET_CONTEXT = 'backup-source-keys';

/**
 * Parses what the admin pasted. A key id that this system also uses (with other material) is fine:
 * the key ring keeps several candidates per id. Throws SourceKeysError('INVALID').
 */
export function parseSourceKeys(text: string): SecretBoxKey[] {
  let keys: SecretBoxKey[];
  try {
    keys = parseKeyRingText(text);
  } catch (err) {
    throw new SourceKeysError(
      'INVALID',
      err instanceof SecretBoxError ? err.message : 'Invalid key text',
    );
  }
  if (keys.length === 0) throw new SourceKeysError('INVALID', 'No key was entered');
  return mergeKeyRings(keys);
}

const redisKey = (ctx: Pick<CoreContext, 'keys'>, token: string) =>
  `${ctx.keys.prefix}:backup:source-keys:${token}`;

/** Validates, encrypts and stores the keys; returns the single-use token for the job. */
export async function stageSourceKeys(ctx: CoreContext, text: string): Promise<string> {
  assertForeignBackupKeysAllowed();
  const keys = parseSourceKeys(text);
  const token = randomBytes(24).toString('base64url');
  await ctx.redis.set(
    redisKey(ctx, token),
    requireCapability(ctx, 'secrets').encrypt(formatKeyRingText(keys), SECRET_CONTEXT),
    'EX',
    SOURCE_KEYS_TTL_SECONDS,
  );
  return token;
}

/** Consumes a token (works once). Throws SourceKeysError('EXPIRED') when it is gone. */
export async function takeSourceKeys(ctx: CoreContext, token: string): Promise<SecretBoxKey[]> {
  assertForeignBackupKeysAllowed();
  if (!SOURCE_KEYS_TOKEN_PATTERN.test(token)) {
    throw new SourceKeysError('EXPIRED', 'The entered encryption key is no longer available');
  }
  const stored = await ctx.redis.getdel(redisKey(ctx, token));
  if (!stored) {
    throw new SourceKeysError(
      'EXPIRED',
      'The entered encryption key is no longer available; enter it again',
    );
  }
  try {
    return parseKeyRingText(requireCapability(ctx, 'secrets').decrypt(stored, SECRET_CONTEXT));
  } catch {
    throw new SourceKeysError('EXPIRED', 'The entered encryption key could not be read');
  }
}

/** The runtime with additional decrypt-only keys (the configured keys stay first). */
export function withSourceKeys(rt: BackupRuntime, keys: readonly SecretBoxKey[]): BackupRuntime {
  if (keys.length === 0) return rt;
  assertForeignBackupKeysAllowed();
  // The entered keys are allowed for archives too (the flag was just checked).
  return {
    ...rt,
    keyRing: mergeKeyRings(rt.keyRing, keys),
    archiveKeyRing: mergeKeyRings(archiveKeys(rt), keys),
  };
}

export type KeyCheckResult = 'MATCH' | 'KEY_UNKNOWN' | 'MISMATCH' | 'NOT_A_BACKUP';

/**
 * Cheap key check: reads only the header and the first encrypted block of the archive.
 * MATCH proves the ARCHIVE key. MISMATCH = the key id is in the ring but the block does not
 * authenticate (wrong key material, or a damaged file).
 */
export async function checkBackupKey(
  bucket: Pick<BackupBucket, 'getStream'>,
  archiveObjectKey: string,
  ring: readonly SecretBoxKey[],
): Promise<KeyCheckResult> {
  const source = await bucket.getStream(archiveObjectKey);
  const stream = source.stream as AsyncIterable<Uint8Array> & { destroy?: () => void };
  try {
    for await (const first of decryptStream(stream, ring)) {
      void first;
      return 'MATCH';
    }
    return 'MISMATCH';
  } catch (err) {
    if (err instanceof BackupCryptoError) {
      if (err.code === 'KEY_UNKNOWN') return 'KEY_UNKNOWN';
      if (err.code === 'NOT_A_BACKUP') return 'NOT_A_BACKUP';
      return 'MISMATCH';
    }
    throw err;
  } finally {
    stream.destroy?.();
  }
}
