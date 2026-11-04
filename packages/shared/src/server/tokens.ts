import { createHash, randomBytes, randomInt } from 'node:crypto';

/** URL-safe random token (session ids, device API tokens, pairing secrets). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are stored only as SHA-256 hashes; the clear token is shown exactly once.
 * High-entropy random tokens do not need a slow KDF.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Crockford Base32 without ambiguous characters (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Human-friendly random code (ticket codes, access codes) using rejection-free randomInt. */
export function generateHumanCode(length: number): string {
  if (!Number.isInteger(length) || length < 4 || length > 64) {
    throw new RangeError('Code length must be an integer between 4 and 64');
  }
  let out = '';
  for (let i = 0; i < length; i += 1) out += CROCKFORD[randomInt(CROCKFORD.length)];
  return out;
}
