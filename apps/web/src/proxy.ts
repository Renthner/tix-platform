import createIntlMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { DEFAULT_LOCALE_HEADER, localizedPath } from '@tix/shared';
import { routing } from './i18n/routing';
import { buildCsp, newNonce } from './server/csp';
import { getDefaultLocale } from './server/default-locale';
import { maintenanceGate } from './server/maintenance-gate';
import { getSeoIndexing } from './server/seo-indexing';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  newSessionToken,
  secureCookies,
  sessionIdFromToken,
} from './server/session-token';

/**
 * The unprefixed language is the live shop default (Settings → General), so the middleware is
 * configured per request; creating one is only a config object, memoised per default locale.
 */
const intlByDefault = new Map<string, ReturnType<typeof createIntlMiddleware>>();
function intlFor(defaultLocale: (typeof routing.locales)[number]) {
  let middleware = intlByDefault.get(defaultLocale);
  if (!middleware) {
    middleware = createIntlMiddleware({ ...routing, defaultLocale });
    intlByDefault.set(defaultLocale, middleware);
  }
  return middleware;
}
const ADMIN_PATH = new RegExp(`^/(?:(?:${routing.locales.join('|')})/)?admin(?:/|$)`);
/** Admin pages reachable without a session (sign-in, forgot password, invitation / reset links). */
const ADMIN_LOGIN = new RegExp(
  `^/(?:(?:${routing.locales.join('|')})/)?admin/(?:login|forgot-password|reset-password|accept-invite|verify-email)/?$`,
);

/**
 * Runs before every page request:
 *  1. locale negotiation / prefixing (next-intl),
 *  2. issues the anonymous session cookie (cart + waiting-room identity),
 *  3. optimistic admin guard (real authorisation happens in layouts and actions).
 * While a backup restore runs, every page (and server action) answers 503 first.
 */
export default async function proxy(request: NextRequest): Promise<NextResponse | Response> {
  const blocked = await maintenanceGate(request);
  if (blocked) return blocked;
  const { pathname } = request.nextUrl;
  const defaultLocale = await getDefaultLocale();
  if (
    ADMIN_PATH.test(pathname) &&
    !ADMIN_LOGIN.test(pathname) &&
    !request.cookies.has('tix_admin')
  ) {
    const prefix = pathname.split('/')[1] ?? '';
    const locale = (routing.locales as readonly string[]).includes(prefix) ? prefix : defaultLocale;
    return NextResponse.redirect(
      new URL(localizedPath(locale, '/admin/login', defaultLocale), request.url),
    );
  }

  // CSP nonce: next-intl copies the request headers when it builds the (rewritten) request, so
  // the headers must be set before it runs. Next reads the nonce from the CSP request header.
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env);
  request.headers.set('x-nonce', nonce);
  // Same value the URL rules used; set (not append) so a client-sent header is overwritten.
  request.headers.set(DEFAULT_LOCALE_HEADER, defaultLocale);
  request.headers.set('Content-Security-Policy', csp);
  const response = intlFor(defaultLocale)(request);
  response.headers.set('Content-Security-Policy', csp);
  // Settings → SEO: indexing switched off (e.g. a test or demo server).
  if (!(await getSeoIndexing())) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
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
