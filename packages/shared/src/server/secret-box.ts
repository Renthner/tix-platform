import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption (AES-256-GCM) for secrets persisted in PostgreSQL
 * (bank PINs, PayPal secret, SMTP password, Ed25519 private keys, wallet certificates).
 *
 * Envelope format (ASCII, safe for TEXT columns):
 *   v1.<keyId>.<iv b64url>.<authTag b64url>.<ciphertext b64url>
 *
 * The key ring supports rotation: the first key encrypts, all keys decrypt.
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
  const keys = spec
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
  if (keys.length === 0) throw new SecretBoxError('Key ring is empty');
  const ids = new Set(keys.map((k) => k.id));
  if (ids.size !== keys.length) throw new SecretBoxError('Duplicate key ids in key ring');
  return keys;
}

export interface SecretBox {
  readonly activeKeyId: string;
  encrypt(plaintext: string, context: string): string;
  decrypt(envelope: string, context: string): string;
  encryptJson(value: unknown, context: string): string;
  decryptJson<T = unknown>(envelope: string, context: string): T;
  /** True when the envelope was produced with a non-active key and should be re-encrypted. */
  needsReEncryption(envelope: string): boolean;
}

export function createSecretBox(keys: SecretBoxKey[]): SecretBox {
  const [active] = keys;
  if (!active) throw new SecretBoxError('At least one encryption key is required');
  const byId = new Map(keys.map((k) => [k.id, k.key]));

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
    const key = byId.get(keyId);
    if (!key) throw new SecretBoxError(`Unknown encryption key id "${keyId}"`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new SecretBoxError(
        'Secret could not be decrypted (wrong key or context, or tampered data)',
      );
    }
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
