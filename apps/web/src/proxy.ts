import createIntlMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { routing } from './i18n/routing';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  newSessionToken,
  secureCookies,
  sessionIdFromToken,
} from './server/session-token';

const intl = createIntlMiddleware(routing);
const ADMIN_PATH = new RegExp(`^/(?:(?:${routing.locales.join('|')})/)?admin(?:/|$)`);
const ADMIN_LOGIN = new RegExp(`^/(?:(?:${routing.locales.join('|')})/)?admin/login/?$`);

/**
 * Runs before every page request:
 *  1. locale negotiation / prefixing (next-intl),
 *  2. issues the anonymous session cookie (cart + waiting-room identity),
 *  3. optimistic admin guard (real authorisation happens in layouts and actions).
 */
export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (
    ADMIN_PATH.test(pathname) &&
    !ADMIN_LOGIN.test(pathname) &&
    !request.cookies.has('tix_admin')
  ) {
    const prefix = pathname.split('/')[1];
    const locale = (routing.locales as readonly string[]).includes(prefix ?? '')
      ? `/${prefix}`
      : '';
    return NextResponse.redirect(new URL(`${locale}/admin/login`, request.url));
  }

  const response = intl(request);
  const secret = process.env.SESSION_SECRET;
  if (secret && !sessionIdFromToken(request.cookies.get(SESSION_COOKIE)?.value, secret)) {
    const { token } = newSessionToken(secret);
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies(process.env.APP_URL),
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
  }
  return response;
}

export const config = {
  // Everything except API routes, Next internals, the socket endpoint and static files.
  matcher: ['/((?!api|_next|_vercel|socket\\.io|.*\\..*).*)'],
};
