import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpAt,
  totpUri,
  verifyTotp,
} from '../src/server/totp';

/** RFC 6238 Appendix B, SHA-1 secret "12345678901234567890" (8-digit vectors). */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(VECTORS)('matches the RFC test vector at t=%i', (t, code) => {
    expect(totpAt(RFC_SECRET, t * 1000, { digits: 8 })).toBe(code);
  });

  it('round-trips base32 and generates 160-bit secrets', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(base32Decode('gezd gnbv-gy3t qojq').toString()).toBe('1234567890');
    expect(() => base32Decode('abc1')).toThrow();
  });

  it('accepts one step of clock drift, not two', () => {
    const now = 1_700_000_000_000;
    const at = (offsetSteps: number) => totpAt(RFC_SECRET, now + offsetSteps * 30_000);
    expect(verifyTotp(RFC_SECRET, at(0), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(-1), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(1), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(2), { nowMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(-2), { nowMs: now })).toBeNull();
  });

  it('rejects malformed input and tolerates spaces', () => {
    const now = 1_700_000_000_000;
    const code = totpAt(RFC_SECRET, now);
    expect(
      verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now }),
    ).not.toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', `${code}x`]) {
      expect(verifyTotp(RFC_SECRET, bad, { nowMs: now })).toBeNull();
    }
  });

  it('protects against replay with the last accepted step', () => {
    const now = 1_700_000_000_000;
    const code = totpAt(RFC_SECRET, now);
    const step = verifyTotp(RFC_SECRET, code, { nowMs: now, lastStep: null });
    expect(step).toBe(Math.floor(now / 30_000));
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, lastStep: step })).toBeNull();
    // An older code of the window is a replay as well, a newer one is fine.
    expect(
      verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30_000), { nowMs: now, lastStep: step }),
    ).toBeNull();
    expect(
      verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30_000), { nowMs: now, lastStep: step }),
    ).not.toBeNull();
  });

  it('builds the otpauth URI', () => {
    const uri = totpUri({ secret: 'ABC234', account: 'a@b.example', issuer: 'My Shop' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/My%20Shop:a%40b\.example\?/);
    expect(uri).toContain('secret=ABC234');
    expect(uri).toContain('issuer=My+Shop');
  });
});
