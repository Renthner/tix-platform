import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { parseThemeCookie } from '@tix/shared';
import {
  FILL_COOKIES,
  PAGE_CACHE_FILL_HEADER,
  PAGE_CACHE_FILL_ID_HEADER,
  PAGE_CACHE_HEADER,
  bypassReason,
  cacheablePage,
  getPageCache,
  isBotUserAgent,
  joinWithNonce,
  nonceFromCsp,
  pageCacheConfig,
  pageCacheKey,
  servedHeaders,
  takePageCacheHint,
  type FillResult,
  type ServedPage,
} from './page-cache';

/**
 * Proxy side of the HTML page cache (see `page-cache.ts`): decides per request, renders a miss
 * through an internal loopback request to THIS process (with a per-process secret header that
 * makes the proxy skip the cache for it) and builds the response of a hit.
 */

const g = globalThis as typeof globalThis & { __tixPageCacheSecret?: string };

function fillSecret(): string {
  return (g.__tixPageCacheSecret ??= randomBytes(32).toString('hex'));
}

/** Is this the internal fill request of this process? (Constant-time comparison.) */
export function isPageCacheFill(headers: Headers): boolean {
  const presented = headers.get(PAGE_CACHE_FILL_HEADER);
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(fillSecret());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Headers of a render that are replayed on hits (everything else is per request or unsafe). */
const STORED_HEADERS = new Set([
  'content-type',
  'vary',
  'cache-control',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'strict-transport-security',
  'content-language',
  // hreflang alternates (next-intl) + style preloads (Next.js, with the render's nonce).
  'link',
]);

export type PageCacheDecision =
  | { kind: 'none' }
  | { kind: 'bypass' }
  | { kind: 'miss' }
  | { kind: 'served'; response: NextResponse; outcome: 'hit' | 'miss' };

/**
 * Serves the request from the page cache when possible. `intl` is the next-intl middleware result
 * for this request (redirects are never cached; its rewrite target tells the resolved locale).
 *  - `none`:   not a cacheable page (or the cache is off): continue normally, no header,
 *  - `bypass`: cacheable page, but this visitor/request must be rendered normally,
 *  - `miss`:   the shared render was not shareable (not HTML, no nonce), failed or a recent
 *              failure suppressed the fill: render normally,
 *  - `served`: response built from a shared render (`hit`, or `miss` for this request's own
 *              render and for every shared non-200 render such as a 404).
 */
export async function pageCacheDecision(args: {
  request: NextRequest;
  intl: Response;
  nonce: string;
  defaultLocale: string;
  locales: readonly string[];
}): Promise<PageCacheDecision> {
  const { request, intl, nonce, defaultLocale, locales } = args;
  const config = pageCacheConfig(process.env);
  if (config.ttlMs === 0) return { kind: 'none' };
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { kind: 'none' };
  if ((intl.status >= 300 && intl.status < 400) || intl.headers.has('location')) {
    return { kind: 'none' };
  }
  const rewrite = intl.headers.get('x-middleware-rewrite');
  let resolved = request.nextUrl.pathname;
  if (rewrite) {
    try {
      resolved = new URL(rewrite, request.url).pathname;
    } catch {
      return { kind: 'none' };
    }
  }
  const page = cacheablePage(resolved, locales);
  if (!page) return { kind: 'none' };

  const cache = getPageCache();
  const reason = bypassReason({
    method,
    headerNames: [...request.headers.keys()],
    cookieNames: request.cookies.getAll().map((c) => c.name),
    searchParams: request.nextUrl.searchParams,
    pathname: request.nextUrl.pathname,
    isBot: isBotUserAgent(request.headers.get('user-agent') ?? ''),
    accept: request.headers.get('accept'),
    secFetchDest: request.headers.get('sec-fetch-dest'),
  });
  const port = process.env.PORT;
  if (reason || !port || !cache.usable) {
    cache.noteBypass();
    return { kind: 'bypass' };
  }

  const url = new URL(request.url);
  // The URL-forming headers the fill forwards, raw (Host, X-Forwarded-Host/-Proto/-Port). Not
  // keyed: Accept-Language (the resolved locale is keyed; locale redirects are never cached),
  // X-Forwarded-For and X-Request-Id (not used by the cacheable renders).
  const key = pageCacheKey({
    host: request.headers.get('host') ?? '',
    forwardedHost: request.headers.get('x-forwarded-host') ?? '',
    forwardedProto: request.headers.get('x-forwarded-proto') ?? '',
    forwardedPort: request.headers.get('x-forwarded-port') ?? '',
    proto: url.protocol.replace(/:$/, ''),
    locale: page.locale,
    defaultLocale,
    pathname: url.pathname,
    theme: parseThemeCookie(request.cookies.get('tix_theme')?.value),
    noticeDismissed: request.cookies.get('tix_cookie_notice')?.value === '1',
  });
  const { page: served, outcome } = await cache.lookup(key, config.ttlMs, () =>
    fillPage(request, url, Number(port), config.fillTimeoutMs),
  );
  if (!served) return { kind: 'miss' };
  return {
    kind: 'served',
    response: buildResponse(served, nonce, intl),
    // A shared non-200 render (e.g. 404) is never a cache hit.
    outcome:
      served.status === 200 && (outcome === 'hit' || outcome === 'coalesced') ? 'hit' : 'miss',
  };
}

function buildResponse(page: ServedPage, nonce: string, intl: Response): NextResponse {
  const headers = new Headers();
  for (const [name, value] of servedHeaders(page, nonce)) headers.append(name, value);
  // Cookies next-intl decided for THIS request (e.g. `tix_locale`); the render's are never replayed.
  for (const cookie of intl.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new NextResponse(joinWithNonce(page.parts, nonce), { status: page.status, headers });
}

/** Renders the public URL through this very process (only safe cookies, uncompressed). */
function fillPage(
  request: NextRequest,
  url: URL,
  port: number,
  timeoutMs: number,
): Promise<FillResult | null> {
  const fillId = randomUUID();
  const cookie = FILL_COOKIES.flatMap((name) => {
    const value = request.cookies.get(name)?.value;
    return value === undefined ? [] : [`${name}=${encodeURIComponent(value)}`];
  }).join('; ');
  const headers: Record<string, string> = {
    host: request.headers.get('host') ?? url.host,
    accept: 'text/html',
    'accept-encoding': 'identity',
    // A fixed browser-like agent: crawlers bypass the cache, so every stored render is the
    // regular (streamed metadata) variant.
    'user-agent': 'tix-page-cache',
    [PAGE_CACHE_FILL_HEADER]: fillSecret(),
    [PAGE_CACHE_FILL_ID_HEADER]: fillId,
  };
  for (const name of [
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-forwarded-for',
    'accept-language',
    'x-request-id',
  ]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  if (cookie) headers.cookie = cookie;

  return new Promise<FillResult | null>((resolve) => {
    let settled = false;
    const done = (value: FillResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A render that never reported (or failed) must not leave its hint slot behind.
      if (!value) takePageCacheHint(fillId);
      resolve(value);
    };
    const req = httpRequest(
      {
        // The web process listens on HOSTNAME (`localhost` in the image, see docker/supervisor).
        host: process.env.HOSTNAME || 'localhost',
        port,
        method: 'GET',
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', () => done(null));
        res.on('end', () => {
          const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (encoding !== 'identity') {
            done(null);
            return;
          }
          const stored: [string, string][] = [];
          for (const [name, value] of Object.entries(res.headers)) {
            if (!STORED_HEADERS.has(name) || value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) stored.push([name, v]);
          }
          const csp = res.headers['content-security-policy'];
          done({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
            headers: stored,
            nonce: nonceFromCsp(Array.isArray(csp) ? csp[0] : csp),
            hint: takePageCacheHint(fillId),
          });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error('page cache fill timed out'));
      done(null);
    }, timeoutMs);
    req.on('error', () => done(null));
    req.end();
  });
}

/** Marks an eligible page response (hit / miss / bypass) for verification and load tests. */
export function markPageCache(response: Response, outcome: 'hit' | 'miss' | 'bypass'): void {
  response.headers.set(PAGE_CACHE_HEADER, outcome);
}
