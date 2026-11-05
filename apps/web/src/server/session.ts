import 'server-only';
import { cookies } from 'next/headers';
import { getEnv } from './env';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  newSessionToken,
  secureCookies,
  sessionIdFromToken,
} from './session-token';

export function cookieDefaults(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secureCookies(getEnv().APP_URL),
    path: '/',
    maxAge,
  };
}

/** Session id from the signed cookie (set by the proxy on the first page view). */
export async function readSessionId(): Promise<string | null> {
  const jar = await cookies();
  return sessionIdFromToken(jar.get(SESSION_COOKIE)?.value, getEnv().SESSION_SECRET);
}

/** Route handlers / server actions only: creates the session cookie when missing. */
export async function ensureSessionId(): Promise<string> {
  const existing = await readSessionId();
  if (existing) return existing;
  const { sid, token } = newSessionToken(getEnv().SESSION_SECRET);
  (await cookies()).set(SESSION_COOKIE, token, cookieDefaults(SESSION_TTL_SECONDS));
  return sid;
}

export const passCookieName = (eventId: string) => `tix_qp_${eventId.replaceAll('-', '')}`;

export async function readPassToken(eventId: string): Promise<string | undefined> {
  return (await cookies()).get(passCookieName(eventId))?.value;
}

export async function writePassToken(
  eventId: string,
  token: string,
  expiresAt: number,
): Promise<void> {
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  (await cookies()).set(passCookieName(eventId), token, cookieDefaults(maxAge));
}
