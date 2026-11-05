import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compact HMAC-SHA256 signed tokens: `<base64url(json)>.<base64url(mac)>`.
 * Used for cart-session cookies, QueuePassTokens and realtime connection tokens.
 * Every token carries a purpose (`typ`) so a token of one kind is never accepted as another.
 */

export interface TokenClaims {
  typ: string;
  /** Expiry (epoch seconds). */
  exp: number;
  [claim: string]: unknown;
}

function mac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data, 'utf8').digest();
}

export function signToken<T extends Record<string, unknown>>(
  typ: string,
  claims: T,
  ttlSeconds: number,
  secret: string,
): string {
  const payload: TokenClaims = { ...claims, typ, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(body, secret).toString('base64url')}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  token: string | undefined | null,
  typ: string,
  secret: string,
): (T & TokenClaims) | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = mac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & TokenClaims;
    if (claims.typ !== typ || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
