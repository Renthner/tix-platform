import { randomUUID } from 'node:crypto';
import { signToken, verifyToken } from '@tix/shared/server';

/**
 * Anonymous browser session (cart + waiting room identity). Pure helpers without
 * `server-only` so the proxy can use them as well.
 */
export const SESSION_COOKIE = 'tix_sid';
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const TOKEN_TYPE = 'sid';

export function newSessionToken(secret: string): { sid: string; token: string } {
  const sid = randomUUID().replaceAll('-', '');
  return { sid, token: signToken(TOKEN_TYPE, { sid }, SESSION_TTL_SECONDS, secret) };
}

export function sessionIdFromToken(token: string | undefined, secret: string): string | null {
  const claims = verifyToken<{ sid: string }>(token, TOKEN_TYPE, secret);
  return claims && typeof claims.sid === 'string' && /^[0-9a-f]{32}$/.test(claims.sid)
    ? claims.sid
    : null;
}

export function secureCookies(appUrl: string | undefined): boolean {
  return (appUrl ?? '').startsWith('https://');
}
