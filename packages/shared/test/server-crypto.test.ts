import { describe, expect, it } from 'vitest';
import {
  SecretBoxError,
  createSecretBox,
  generateHumanCode,
  generateKeyRingEntry,
  hashPassword,
  hashToken,
  needsRehash,
  parseKeyRing,
  verifyPassword,
} from '../src/server';

describe('secret box (AES-256-GCM)', () => {
  const ring = parseKeyRing(generateKeyRingEntry('k1'));
  const box = createSecretBox(ring);

  it('round-trips JSON bound to a context', () => {
    const envelope = box.encryptJson({ pin: '12345' }, 'bank_connections:abc');
    expect(envelope.startsWith('v1.k1.')).toBe(true);
    expect(box.decryptJson(envelope, 'bank_connections:abc')).toEqual({ pin: '12345' });
  });

  it('refuses decryption under a different context (copied ciphertext)', () => {
    const envelope = box.encrypt('secret', 'settings:paypal.credentials');
    expect(() => box.decrypt(envelope, 'settings:smtp.credentials')).toThrow(SecretBoxError);
  });

  it('detects tampering', () => {
    const envelope = box.encrypt('secret', 'ctx');
    const parts = envelope.split('.');
    parts[4] = Buffer.from('forged').toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'ctx')).toThrow(SecretBoxError);
  });

  it('supports key rotation: old keys decrypt, new key encrypts', () => {
    const old = box.encrypt('legacy', 'ctx');
    const previousKey = `k1:${ring[0]!.key.toString('base64')}`;
    const rotated = createSecretBox(parseKeyRing(`${generateKeyRingEntry('k2')},${previousKey}`));
    expect(rotated.decrypt(old, 'ctx')).toBe('legacy');
    expect(rotated.needsReEncryption(old)).toBe(true);
    expect(rotated.encrypt('x', 'ctx').startsWith('v1.k2.')).toBe(true);
  });

  it('validates key ring entries', () => {
    expect(() => parseKeyRing('k1:dG9vLXNob3J0')).toThrow(/32 bytes/);
    expect(() => parseKeyRing('')).toThrow(/empty/);
  });
});

describe('password hashing (argon2id)', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
    expect(needsRehash(hash)).toBe(false);
    expect(needsRehash(hash, { memoryKiB: 65_536, passes: 3, parallelism: 1 })).toBe(true);
  });

  it('rejects malformed hashes without throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('tokens', () => {
  it('produces human codes from an unambiguous alphabet', () => {
    const code = generateHumanCode(12);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  });

  it('hashes tokens deterministically', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toHaveLength(64);
  });
});
