import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238, HMAC-SHA1) for authenticator apps – built on node:crypto, no dependency.
 *
 * Secrets travel as unpadded RFC 4648 base32 (what authenticator apps expect). Verification
 * accepts a configurable window of time steps around "now" and supports replay protection:
 * the caller passes the last accepted step and stores the returned one.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Time steps accepted before / after the current one (clock drift). */
export const TOTP_WINDOW = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new RangeError('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New random secret (160 bit, the RFC 4226 recommendation) as base32. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** HOTP value (RFC 4226) for an 8-byte big-endian counter. */
export function hotp(key: Uint8Array, counter: number | bigint, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
}

export const totpStep = (timeMs: number, periodSeconds = TOTP_PERIOD_SECONDS): number =>
  Math.floor(timeMs / 1000 / periodSeconds);

/** Code for the time step containing `timeMs`. */
export function totpAt(secret: string, timeMs: number, options: TotpOptions = {}): string {
  return hotp(
    base32Decode(secret),
    totpStep(timeMs, options.periodSeconds),
    options.digits ?? TOTP_DIGITS,
  );
}

export interface VerifyTotpOptions extends TotpOptions {
  nowMs?: number;
  window?: number;
  /** Last accepted time step of this user – the same or an older step is a replay. */
  lastStep?: number | null;
}

/**
 * Checks a user-entered code. Returns the matching time step (store it as the new last step)
 * or null for a wrong, expired or replayed code.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: VerifyTotpOptions = {},
): number | null {
  const digits = options.digits ?? TOTP_DIGITS;
  const given = code.replace(/\s/g, '');
  if (given.length !== digits || !/^[0-9]+$/.test(given)) return null;
  const key = base32Decode(secret);
  const current = totpStep(options.nowMs ?? Date.now(), options.periodSeconds);
  const window = options.window ?? TOTP_WINDOW;
  let matched: number | null = null;
  // Check every step (no early exit) so timing does not reveal which one matched.
  for (let step = current - window; step <= current + window; step += 1) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step, digits));
    const equal = timingSafeEqual(expected, Buffer.from(given));
    if (equal && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (options.lastStep != null && matched <= options.lastStep) return null;
  return matched;
}

/** `otpauth://` URI for the QR code of authenticator apps. */
export function totpUri(params: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
