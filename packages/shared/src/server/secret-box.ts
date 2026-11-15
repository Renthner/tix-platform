import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption (AES-256-GCM) for secrets persisted in PostgreSQL
 * (bank PINs, PayPal secret, SMTP password, Ed25519 private keys, wallet certificates).
 *
 * Envelope format (ASCII, safe for TEXT columns):
 *   v1.<keyId>.<iv b64url>.<authTag b64url>.<ciphertext b64url>
 *
 * The key ring supports rotation: the first key encrypts, all keys decrypt. A ring may hold
 * several keys under ONE id (two installations that both used e.g. `k1`; see `key-ring.ts`):
 * decrypting tries every candidate of the envelope's id, encrypting always uses the first key.
 * `context` is bound as additional authenticated data so a ciphertext copied into a
 * different row/column fails to decrypt.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export interface SecretBoxKey {
  id: string;
  key: Buffer;
}

export class SecretBoxError extends Error {
  override name = 'SecretBoxError';
}

/**
 * Parses `APP_ENCRYPTION_KEYS`: comma separated `keyId:base64Key` pairs, the first one is
 * the active encryption key. Example: `k2:3q…=,k1:9f…=`
 */
export function parseKeyRing(spec: string): SecretBoxKey[] {
  const keys = parseKeyRingLoose(spec);
  if (keys.length === 0) throw new SecretBoxError('Key ring is empty');
  const ids = new Set(keys.map((k) => k.id));
  if (ids.size !== keys.length) throw new SecretBoxError('Duplicate key ids in key ring');
  return keys;
}

/**
 * Like `parseKeyRing` but accepts an empty list and the same id more than once (the additional,
 * decrypt-only keys of other systems may reuse an id of this one).
 */
export function parseKeyRingLoose(spec: string): SecretBoxKey[] {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const sep = part.indexOf(':');
      if (sep <= 0) throw new SecretBoxError('Key ring entries must look like "<id>:<base64>"');
      const id = part.slice(0, sep);
      if (!KEY_ID_PATTERN.test(id)) throw new SecretBoxError(`Invalid key id "${id}"`);
      const key = Buffer.from(part.slice(sep + 1), 'base64');
      if (key.length !== KEY_BYTES) {
        throw new SecretBoxError(
          `Key "${id}" must decode to ${KEY_BYTES} bytes, got ${key.length}`,
        );
      }
      return { id, key };
    });
}

/** Short stable label of a key (reveals nothing useful): 8 hex chars of SHA-256 over id + material. */
export function keyFingerprint(key: SecretBoxKey): string {
  return createHash('sha256').update(key.id).update('\0').update(key.key).digest('hex').slice(0, 8);
}

/** Display label that tells equal ids apart, e.g. `k1 (1a2b3c4d)`. The fingerprint is not key material. */
export const keyLabel = (key: SecretBoxKey): string => `${key.id} (${keyFingerprint(key)})`;

/** Order independent fingerprint of a whole ring (detects that a reloaded ring changed). */
export function ringFingerprint(keys: readonly SecretBoxKey[]): string {
  return keys.map(keyFingerprint).sort().join(',');
}

export interface SecretBox {
  readonly activeKeyId: string;
  encrypt(plaintext: string, context: string): string;
  decrypt(envelope: string, context: string): string;
  encryptJson(value: unknown, context: string): string;
  decryptJson<T = unknown>(envelope: string, context: string): T;
  /**
   * True when the envelope names a non-active key id and should be re-encrypted. It compares ids
   * only (a different key under the active id is not detected): the re-encryption routine tries
   * the active key itself instead.
   */
  needsReEncryption(envelope: string): boolean;
}

export function createSecretBox(keys: SecretBoxKey[]): SecretBox {
  const [active] = keys;
  if (!active) throw new SecretBoxError('At least one encryption key is required');
  const byId = new Map<string, Buffer[]>();
  for (const k of keys) byId.set(k.id, [...(byId.get(k.id) ?? []), k.key]);

  const encrypt = (plaintext: string, context: string): string => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', active.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      active.id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  };

  const decrypt = (envelope: string, context: string): string => {
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new SecretBoxError('Unsupported secret envelope format');
    }
    const [, keyId, ivB64, tagB64, dataB64] = parts as [string, string, string, string, string];
    const candidates = byId.get(keyId);
    if (!candidates) throw new SecretBoxError(`Unknown encryption key id "${keyId}"`);
    // Several keys can share an id: the one that authenticates is the right one (AES-GCM tag).
    for (const key of candidates) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(dataB64, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        /* try the next candidate */
      }
    }
    throw new SecretBoxError(
      'Secret could not be decrypted (wrong key or context, or tampered data)',
    );
  };

  return {
    activeKeyId: active.id,
    encrypt,
    decrypt,
    encryptJson: (value, context) => encrypt(JSON.stringify(value), context),
    decryptJson: <T>(envelope: string, context: string) =>
      JSON.parse(decrypt(envelope, context)) as T,
    needsReEncryption: (envelope) => envelope.split('.')[1] !== active.id,
  };
}

/** Generates a new random key ring entry, e.g. for `.env` bootstrap. */
export function generateKeyRingEntry(id = 'k1'): string {
  if (!KEY_ID_PATTERN.test(id)) throw new SecretBoxError(`Invalid key id "${id}"`);
  return `${id}:${randomBytes(KEY_BYTES).toString('base64')}`;
}
