/**
 * Full-page HTML micro-cache for ANONYMOUS visitors of the shop start page and the public event
 * pages. The proxy side (eligibility, internal render, hit response) is `page-cache-proxy.ts`.
 *
 * Why: at a presale start hundreds of visitors open the same event page within one second; every
 * render is CPU-bound SSR. Here one render per process and key is shared by everybody for a few
 * seconds (`TIX_PAGE_CACHE_TTL_MS`, default 5 s, max 60 s, `0` = off). Concurrent misses of one
 * key wait for a single render (single-flight).
 *
 * Correctness rules:
 *  - two anonymous renders of the same page differ only by the CSP nonce (and the order of
 *    streamed flight rows), so the stored body is split on its nonce and re-joined with the nonce
 *    of the request it is served to,
 *  - everything a render can depend on is part of the key (Host / X-Forwarded-Host /
 *    X-Forwarded-Proto headers, protocol, locale, default locale, path, theme cookie,
 *    cookie-notice cookie); signed-in visitors (admin or customer cookies), bots, requests with a
 *    query string, RSC/router requests and HEAD bypass the cache,
 *  - renders showing an errored boundary (error UI streamed with status 200) are never stored,
 *  - entries die with any invalidation of the shop data cache or any settings change (generation
 *    counter), are never stored while the invalidation subscription is not confirmed, and never
 *    outlive the next sale-state boundary of an event the page shows (reported by the page
 *    itself; a page that reports nothing is never stored).
 *
 * Standalone on purpose (no `server-only`, no `@tix/core`, no Next.js imports, relative imports
 * only): it is imported by `proxy.ts`, `core.ts`, the two pages and the `node --test` unit tests.
 * State lives on `globalThis` because Next.js bundles server code into several module layers.
 */

/** Response header on every eligible page response: `hit`, `miss` or `bypass`. */
export const PAGE_CACHE_HEADER = 'x-tix-page-cache';
/** Request header of the internal fill request (per-process random secret). */
export const PAGE_CACHE_FILL_HEADER = 'x-tix-page-cache-fill';
/** Request header of the internal fill request: id under which the page reports its hint. */
export const PAGE_CACHE_FILL_ID_HEADER = 'x-tix-page-cache-fill-id';

export type PageCacheOutcome = 'hit' | 'miss' | 'bypass';

/* ---------------------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------------------- */

export interface PageCacheConfig {
  /** Entry lifetime; 0 switches the cache off completely. */
  ttlMs: number;
  /** Memory budget per process (stored bodies + headers, 2 bytes per UTF-16 code unit). */
  maxBytes: number;
  maxEntries: number;
  /** Upper bound for one internal render. */
  fillTimeoutMs: number;
}

export const PAGE_CACHE_DEFAULTS: PageCacheConfig = {
  ttlMs: 5_000,
  maxBytes: 32 * 1024 * 1024,
  maxEntries: 500,
  fillTimeoutMs: 15_000,
};

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Upper bound of `TIX_PAGE_CACHE_TTL_MS` (larger values are clamped to it). */
export const PAGE_CACHE_MAX_TTL_MS = 60_000;

/**
 * `TIX_PAGE_CACHE_TTL_MS` (0-60000, larger values are clamped to 60000; default 5000; default 0
 * under `next dev`, where code changes must show at once) and `TIX_PAGE_CACHE_MAX_MB` (1-4096,
 * default 32).
 */
export function pageCacheConfig(env: Record<string, string | undefined>): PageCacheConfig {
  const defaultTtl = env.NODE_ENV === 'development' ? 0 : PAGE_CACHE_DEFAULTS.ttlMs;
  return {
    ...PAGE_CACHE_DEFAULTS,
    ttlMs: Math.min(
      intEnv(env.TIX_PAGE_CACHE_TTL_MS, defaultTtl, 0, Number.MAX_SAFE_INTEGER),
      PAGE_CACHE_MAX_TTL_MS,
    ),
    maxBytes: intEnv(env.TIX_PAGE_CACHE_MAX_MB, 32, 1, 4096) * 1024 * 1024,
  };
}

/* ---------------------------------------------------------------------------------------
 * Eligibility and key
 * ------------------------------------------------------------------------------------- */

export interface CacheablePage {
  kind: 'start' | 'event';
  locale: string;
}

/**
 * Start page (`/<locale>`) or an event page (`/<locale>/events/<slug>`), matched on the pathname
 * next-intl resolved (rewritten) the request to.
 */
export function cacheablePage(
  resolvedPathname: string,
  locales: readonly string[],
): CacheablePage | null {
  const m = /^\/([^/]+)(?:\/events\/([^/]+))?$/.exec(resolvedPathname);
  if (!m || !locales.includes(m[1]!)) return null;
  return { kind: m[2] ? 'event' : 'start', locale: m[1]! };
}

/**
 * Request headers of client-side navigations / prefetches and server actions. NOTE: Next.js strips
 * `RSC`, `Next-Router-*` and the `_rsc` query parameter from the request BEFORE the proxy runs, so
 * these checks are only a second line; the real guard is `isDocumentRequest`.
 */
const ROUTER_HEADERS = ['rsc', 'next-action', 'next-url'];

/**
 * A top-level HTML document request: `Accept` names `text/html` (browsers send it for
 * navigations; the App Router's flight fetches send none, i.e. the fetch default "any type") and
 * `Sec-Fetch-Dest`, when present, is `document`. Everything else (RSC navigations, prefetches,
 * fetch() calls, tools that send no Accept header) is rendered normally.
 */
export function isDocumentRequest(accept: string | null, secFetchDest: string | null): boolean {
  if (!accept || !/\btext\/html\b/i.test(accept)) return false;
  return secFetchDest === null || secFetchDest === '' || secFetchDest.toLowerCase() === 'document';
}

/*
 * Crawler detection, vendored from Next.js 16.4.6 (`next/dist/shared/lib/router/utils/is-bot.js`
 * + `html-bots.js`; deep imports of Next internals are not a stable API). Next renders metadata
 * blocking (not streamed) for these agents, so their renders must neither be stored nor served
 * from the cache. Re-sync when Next.js changes its lists.
 */
const HEADLESS_BROWSER_BOT_UA_RE = /Googlebot(?!-)|Googlebot$/i;
const HTML_LIMITED_BOT_UA_RE =
  /[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i;

/** Same answer as Next.js' `isBot` (see above). */
export function isBotUserAgent(userAgent: string): boolean {
  return HEADLESS_BROWSER_BOT_UA_RE.test(userAgent) || HTML_LIMITED_BOT_UA_RE.test(userAgent);
}

/** Longer request paths are rendered normally (bounded key size). */
export const MAX_CACHEABLE_PATH_LENGTH = 512;

/** Signed-in or personalised visitors: admin portal cookies (all `tix_admin*`) and customers. */
export function isPersonalCookie(name: string): boolean {
  return name.startsWith('tix_admin') || name === 'tix_customer';
}

export interface RequestFacts {
  method: string;
  /** Lower-case header names present on the request. */
  headerNames: readonly string[];
  cookieNames: readonly string[];
  searchParams: URLSearchParams;
  /** Public path as requested (length-capped for the key). */
  pathname: string;
  isBot: boolean;
  accept: string | null;
  secFetchDest: string | null;
}

/**
 * Why the request must be rendered normally although its page is cacheable, or null when it may
 * be served from the cache. Only GET and HEAD reach this (other methods are not eligible at all).
 *
 * Query strings: neither cacheable page reads a query parameter on the server (the only one read
 * at all, `?expired=1`, is read client-side after hydration). Still, any request WITH a query is
 * rendered normally: keying on it would let arbitrary values (`?utm_source=<random>`, per-click
 * ids like `fbclid`) flood and evict the cache, and serving the entry of the bare path instead is
 * not verified to be safe - Next.js embeds the rendered search in the flight payload, which would
 * then differ from `location.search` during hydration. Trade-off: campaign/newsletter links with
 * tracking parameters bypass the cache. Stripping tracking parameters needs a browser hydration
 * test first.
 */
export function bypassReason(facts: RequestFacts): string | null {
  if (facts.method !== 'GET') return 'method';
  if (!isDocumentRequest(facts.accept, facts.secFetchDest)) return 'not-document';
  if (facts.headerNames.some((h) => ROUTER_HEADERS.includes(h) || h.startsWith('next-router-'))) {
    return 'router';
  }
  if (facts.searchParams.has('_rsc')) return 'router';
  if ([...facts.searchParams.keys()].length > 0) return 'query';
  if (facts.pathname.length > MAX_CACHEABLE_PATH_LENGTH) return 'long-path';
  if (facts.cookieNames.some(isPersonalCookie)) return 'personal';
  // Next.js renders metadata differently for crawlers (blocking instead of streamed).
  if (facts.isBot) return 'bot';
  return null;
}

export interface KeyParts {
  /** `Host` header as sent (the fill forwards it unchanged). */
  host: string;
  /** `X-Forwarded-Host` as sent ('' = absent; forwarded unchanged by the fill). */
  forwardedHost: string;
  /** `X-Forwarded-Proto` as sent ('' = absent; forwarded unchanged by the fill). */
  forwardedProto: string;
  /** `X-Forwarded-Port` as sent ('' = absent; forwarded unchanged by the fill). */
  forwardedPort: string;
  /** Protocol of the request URL as Next.js saw it (`http` / `https`). */
  proto: string;
  locale: string;
  defaultLocale: string;
  /** Public path as requested (before the locale rewrite). Requests with a query never get here. */
  pathname: string;
  /** Parsed `tix_theme` cookie (null = absent or unknown). */
  theme: string | null;
  /** `tix_cookie_notice` === '1'. */
  noticeDismissed: boolean;
}

export function pageCacheKey(p: KeyParts): string {
  return JSON.stringify([
    p.host.toLowerCase(),
    p.forwardedHost.toLowerCase(),
    p.forwardedProto.toLowerCase(),
    p.forwardedPort,
    p.proto,
    p.locale,
    p.defaultLocale,
    p.pathname,
    p.theme ?? '',
    p.noticeDismissed ? 1 : 0,
  ]);
}

/*
 * Error UI detection. React (Fizz) marks a Suspense boundary whose content failed on the server -
 * a thrown error, `notFound()` or `redirect()` below the shell - with `<!--$!-->` (boundary
 * errored before it was flushed) or a `$RX("…")` instruction / `<template data-rxi …>` (errored
 * after streaming started); the response status is 200 then. Errors in the shell itself already
 * come back as non-200. React escapes `<` and `"` in text and Next.js escapes them in the flight
 * payload, so page content cannot fake the markers. A match only prevents storing (never wrong);
 * client-side-rendering bailouts (`next/dynamic` with `ssr: false`) use the same marker, so a page
 * using them would never be stored - the cacheable pages do not (the e2e hit tests would fail).
 */
const ERRORED_BOUNDARY_RE = /<!--\$!-->|\$RX\("|<template data-rxi=/;

/** True when the rendered HTML contains a server-side errored Suspense boundary. */
export function hasErroredBoundary(html: string): boolean {
  return ERRORED_BOUNDARY_RE.test(html);
}

/** Cookies a cacheable render may read; the internal fill request carries only these. */
export const FILL_COOKIES = ['tix_theme', 'tix_cookie_notice', 'tix_locale'] as const;

/* ---------------------------------------------------------------------------------------
 * Nonce handling
 * ------------------------------------------------------------------------------------- */

/** The nonce of a Content-Security-Policy header value (`'nonce-…'`). */
export function nonceFromCsp(csp: string | null | undefined): string | null {
  const m = /'nonce-([A-Za-z0-9+/_=-]+)'/.exec(csp ?? '');
  return m ? m[1]! : null;
}

/** The body split on every occurrence of the nonce (joined again with another nonce per hit). */
export function splitOnNonce(body: string, nonce: string): string[] {
  return body.split(nonce);
}

export function joinWithNonce(parts: readonly string[], nonce: string): string {
  return parts.join(nonce);
}

/* ---------------------------------------------------------------------------------------
 * Sale-state boundaries (reported by the page during the internal render)
 * ------------------------------------------------------------------------------------- */

/** Entries whose boundary is closer than this are not stored at all. */
export const MIN_ENTRY_LIFETIME_MS = 500;

/** Earliest of `dates` that lies in the future (epoch ms), or null. */
export function nextBoundary(
  dates: readonly (Date | string | number | null | undefined)[],
  now: number = Date.now(),
): number | null {
  let best: number | null = null;
  for (const d of dates) {
    if (d === null || d === undefined) continue;
    const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
    if (!Number.isFinite(t) || t <= now) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

/** Expiry of a new entry (capped at the boundary), or null when it must not be stored. */
export function entryExpiry(now: number, ttlMs: number, boundary: number | null): number | null {
  if (!(ttlMs > 0)) return null;
  const expires = boundary === null ? now + ttlMs : Math.min(now + ttlMs, boundary);
  return expires - now < MIN_ENTRY_LIFETIME_MS ? null : expires;
}

interface Hint {
  boundary: number | null;
  at: number;
}

const g = globalThis as typeof globalThis & {
  __tixPageCacheHints?: Map<string, Hint>;
  __tixPageCache?: PageCacheStore;
  __tixPageCacheSync?: PageCacheSync;
  __tixPageCacheLocalGeneration?: number;
};

function hints(): Map<string, Hint> {
  return (g.__tixPageCacheHints ??= new Map());
}

const HINT_MAX_AGE_MS = 60_000;
const HINT_MAX_ENTRIES = 1_000;

/** Called by the page during the internal render (no-op for every other request). */
export function reportPageCacheHint(fillId: string | null | undefined, boundary: number | null) {
  if (!fillId) return;
  const map = hints();
  const now = Date.now();
  if (map.size >= HINT_MAX_ENTRIES) {
    for (const [id, hint] of map) if (now - hint.at > HINT_MAX_AGE_MS) map.delete(id);
    if (map.size >= HINT_MAX_ENTRIES) map.clear();
  }
  map.set(fillId, { boundary, at: now });
}

/**
 * For the two cacheable pages: reports the earliest upcoming sale-state boundary of the events the
 * page shows. Call it after all data was loaded (a render that fails before never reports and is
 * therefore never stored).
 */
export function reportPageCacheBoundary(
  requestHeaders: { get(name: string): string | null },
  dates: readonly (Date | string | number | null | undefined)[],
): void {
  const fillId = requestHeaders.get(PAGE_CACHE_FILL_ID_HEADER);
  if (fillId) reportPageCacheHint(fillId, nextBoundary(dates));
}

/** The hint of a finished internal render (undefined = the page reported nothing). */
export function takePageCacheHint(fillId: string): { boundary: number | null } | undefined {
  const map = hints();
  const hint = map.get(fillId);
  map.delete(fillId);
  return hint ? { boundary: hint.boundary } : undefined;
}

/* ---------------------------------------------------------------------------------------
 * Invalidation source (registered by core.ts once the shop cache sync is started)
 * ------------------------------------------------------------------------------------- */

export interface PageCacheSync {
  /** True while the cross-process invalidation subscription is confirmed. */
  synced(): boolean;
  /** Changes whenever shop data was invalidated (locally or by another process). */
  generation(): number;
}

export function registerPageCacheSync(sync: PageCacheSync): void {
  g.__tixPageCacheSync = sync;
}

/** Drops every entry of this process (settings changed, subscription re-established, ...). */
export function flushPageCache(): void {
  g.__tixPageCacheLocalGeneration = (g.__tixPageCacheLocalGeneration ?? 0) + 1;
}

const globalSync: PageCacheSync = {
  synced: () => g.__tixPageCacheSync?.synced() ?? false,
  generation: () =>
    (g.__tixPageCacheLocalGeneration ?? 0) + (g.__tixPageCacheSync?.generation() ?? 0),
};

/* ---------------------------------------------------------------------------------------
 * Store: LRU with byte + entry caps, single-flight fills
 * ------------------------------------------------------------------------------------- */

/** What a render produced (headers already reduced to the safe allowlist). */
export interface FillResult {
  status: number;
  contentType: string;
  body: string;
  headers: readonly (readonly [string, string])[];
  /** Nonce of the render (from its CSP header). */
  nonce: string | null;
  /** Hint reported by the page; undefined = none (never stored). */
  hint: { boundary: number | null } | undefined;
}

/**
 * A shareable render: body and header values split around the render's nonce (the `Link` header
 * carries it for style preloads). Treat as immutable. Stored entries are always status 200; a
 * non-200 HTML render (e.g. 404) is only handed to the requests that waited for it.
 */
export interface ServedPage {
  status: number;
  parts: readonly string[];
  headers: readonly (readonly [string, readonly string[]])[];
}

/** Header values of a served page with `nonce` filled in. */
export function servedHeaders(page: ServedPage, nonce: string): [string, string][] {
  return page.headers.map(([name, parts]) => [name, joinWithNonce(parts, nonce)]);
}

interface Entry extends ServedPage {
  bytes: number;
  expiresAt: number;
}

export interface PageCacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  /** Requests that joined a render already in flight. */
  coalesced: number;
  bypasses: number;
  fills: number;
  fillErrors: number;
  /** Misses that started no fill because a fill of the key failed moments ago. */
  fillsSuppressed: number;
  /** Renders that were served but not stored (not HTML 200, no hint, boundary, invalidated). */
  notStored: number;
  flushes: number;
}

export interface LookupResult {
  /**
   * null: the render was not shareable (not HTML or no nonce), failed or was suppressed after a
   * recent failure - render normally. A non-200 page (e.g. 404) is shared with the waiters only.
   */
  page: ServedPage | null;
  outcome: 'hit' | 'miss' | 'coalesced';
}

/**
 * After a failed fill (error / timeout) of a key, no new fill of it starts for this long: those
 * requests render normally, so a failing render is not retried by every wave of visitors through
 * the loopback. No stale-if-error: an expired entry may have been capped at a sale boundary.
 */
export const FILL_FAILURE_BACKOFF_MS = 2_000;

/** Bytes an entry is charged: V8 strings may be two-byte (worst case 2 bytes per code unit). */
export function pageBytes(body: string, headers: readonly (readonly [string, string])[]): number {
  let units = body.length;
  for (const [name, value] of headers) units += name.length + value.length;
  return 2 * units;
}

export interface StoreOptions {
  maxBytes: number;
  maxEntries: number;
  now?: () => number;
  sync?: PageCacheSync;
}

export class PageCacheStore {
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #sync: PageCacheSync;
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, Promise<ServedPage | null>>();
  /** Key → moment until which no new fill starts (recent fill failure). */
  readonly #failures = new Map<string, number>();
  #bytes = 0;
  #seenGeneration: number;
  readonly #stats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    bypasses: 0,
    fills: 0,
    fillErrors: 0,
    fillsSuppressed: 0,
    notStored: 0,
    flushes: 0,
  };

  constructor(options: StoreOptions) {
    this.#maxBytes = options.maxBytes;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
    this.#sync = options.sync ?? globalSync;
    this.#seenGeneration = this.#sync.generation();
  }

  /** Whether entries may be served / stored right now (subscription confirmed). */
  get usable(): boolean {
    return this.#sync.synced();
  }

  noteBypass(): void {
    this.#stats.bypasses += 1;
  }

  /**
   * Cached page for `key`, or the result of ONE `fill` shared by all concurrent callers. The
   * result is stored when it is an HTML 200 with a nonce and a page hint, shows no errored
   * boundary, nothing was invalidated while it rendered and its boundary allows a minimum
   * lifetime. Non-200 HTML renders with a nonce (e.g. 404) are shared with the waiters but never
   * stored. A failed fill suppresses new fills of the key for `FILL_FAILURE_BACKOFF_MS`.
   */
  async lookup(
    key: string,
    ttlMs: number,
    fill: () => Promise<FillResult | null>,
  ): Promise<LookupResult> {
    this.#checkGeneration();
    const now = this.#now();
    const hit = this.#entries.get(key);
    if (hit) {
      if (hit.expiresAt > now) {
        this.#entries.delete(key);
        this.#entries.set(key, hit);
        this.#stats.hits += 1;
        return { page: hit, outcome: 'hit' };
      }
      this.#remove(key);
    }
    const running = this.#flights.get(key);
    if (running) {
      this.#stats.coalesced += 1;
      return { page: await running, outcome: 'coalesced' };
    }
    this.#stats.misses += 1;
    const failedUntil = this.#failures.get(key);
    if (failedUntil !== undefined) {
      if (failedUntil > now) {
        this.#stats.fillsSuppressed += 1;
        return { page: null, outcome: 'miss' };
      }
      this.#failures.delete(key);
    }
    const startGeneration = this.#seenGeneration;
    const flight: Promise<ServedPage | null> = (async () => {
      this.#stats.fills += 1;
      let result: FillResult | null;
      try {
        result = await fill();
      } catch {
        result = null;
      }
      if (!result) {
        this.#stats.fillErrors += 1;
        this.#noteFailure(key);
        return null;
      }
      // Redirects and other non-error statuses depend on headers that are not replayed (Location).
      const shareableStatus = result.status === 200 || result.status >= 400;
      if (!shareableStatus || !/^text\/html\b/i.test(result.contentType) || !result.nonce) {
        this.#stats.notStored += 1;
        return null;
      }
      const nonce = result.nonce;
      const page: ServedPage = {
        status: result.status,
        parts: splitOnNonce(result.body, nonce),
        headers: result.headers.map(([name, value]) => [name, splitOnNonce(value, nonce)]),
      };
      if (result.status !== 200) {
        this.#stats.notStored += 1;
        return page;
      }
      const storedAt = this.#now();
      const expiresAt = result.hint ? entryExpiry(storedAt, ttlMs, result.hint.boundary) : null;
      this.#checkGeneration();
      if (
        expiresAt === null ||
        hasErroredBoundary(result.body) ||
        !this.#sync.synced() ||
        this.#seenGeneration !== startGeneration ||
        !this.#store(key, page, pageBytes(result.body, result.headers), expiresAt)
      ) {
        this.#stats.notStored += 1;
      }
      return page;
    })().finally(() => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    });
    this.#flights.set(key, flight);
    return { page: await flight, outcome: 'miss' };
  }

  clear(): void {
    this.#stats.flushes += 1;
    this.#entries.clear();
    this.#flights.clear();
    this.#failures.clear();
    this.#bytes = 0;
  }

  /** Remembers a failed fill (bounded: expired marks go first, then everything). */
  #noteFailure(key: string): void {
    const now = this.#now();
    if (this.#failures.size >= this.#maxEntries) {
      for (const [k, until] of this.#failures) if (until <= now) this.#failures.delete(k);
      if (this.#failures.size >= this.#maxEntries) this.#failures.clear();
    }
    this.#failures.set(key, now + FILL_FAILURE_BACKOFF_MS);
  }

  stats(): PageCacheStats {
    return { entries: this.#entries.size, bytes: this.#bytes, ...this.#stats };
  }

  /** Invalidation anywhere since the last look: flush, and new callers never join old renders. */
  #checkGeneration(): void {
    const generation = this.#sync.generation();
    if (generation === this.#seenGeneration) return;
    this.#seenGeneration = generation;
    this.clear();
  }

  #store(key: string, page: ServedPage, bytes: number, expiresAt: number): boolean {
    if (bytes > this.#maxBytes) return false;
    this.#remove(key);
    const now = this.#now();
    // Expired entries first, then least recently used.
    if (this.#bytes + bytes > this.#maxBytes || this.#entries.size >= this.#maxEntries) {
      for (const [k, e] of this.#entries) if (e.expiresAt <= now) this.#remove(k);
    }
    while (
      this.#entries.size > 0 &&
      (this.#bytes + bytes > this.#maxBytes || this.#entries.size >= this.#maxEntries)
    ) {
      this.#remove(this.#entries.keys().next().value!);
    }
    this.#entries.set(key, { ...page, bytes, expiresAt });
    this.#bytes += bytes;
    return true;
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }
}

/**
 * Runs a page-cache step of the proxy; a throw is reported and answered with `fallback`, so a
 * cache bug can only cost the cache, never the page. `report` itself must not break it either.
 */
export async function withPageCacheFallback<T>(
  run: () => Promise<T>,
  fallback: T,
  report: (err: unknown) => void,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    try {
      report(err);
    } catch {
      // Logging failed as well: still serve the page.
    }
    return fallback;
  }
}

/** Process-wide store (configuration read once from the environment). */
export function getPageCache(): PageCacheStore {
  if (!g.__tixPageCache) {
    const config = pageCacheConfig(process.env);
    g.__tixPageCache = new PageCacheStore({
      maxBytes: config.maxBytes,
      maxEntries: config.maxEntries,
    });
  }
  return g.__tixPageCache;
}

/** Stats of this process, or null when the cache was never used here. */
export function pageCacheStats(): PageCacheStats | null {
  return g.__tixPageCache?.stats() ?? null;
}

/** Prometheus lines for `/api/metrics` (per web process, like the shop cache figures). */
export function renderPageCachePrometheus(stats: PageCacheStats | null): string {
  if (!stats) return '';
  const lines: string[] = [];
  const metric = (name: string, help: string, type: string, rows: [string, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of rows) lines.push(`${name}${labels} ${value}`);
  };
  metric('tix_page_cache_entries', 'Pages in the HTML page cache of this web process.', 'gauge', [
    ['', stats.entries],
  ]);
  metric(
    'tix_page_cache_bytes',
    'Bytes held by the HTML page cache of this web process.',
    'gauge',
    [['', stats.bytes]],
  );
  metric(
    'tix_page_cache_requests_total',
    'Cacheable page requests by result (since process start).',
    'counter',
    (
      [
        ['hit', stats.hits],
        ['miss', stats.misses],
        ['coalesced', stats.coalesced],
        ['bypass', stats.bypasses],
      ] as const
    ).map(([result, value]) => [`{result="${result}"}`, value]),
  );
  metric('tix_page_cache_fills_total', 'Internal page renders started.', 'counter', [
    ['', stats.fills],
  ]);
  metric('tix_page_cache_fill_errors_total', 'Internal page renders that failed.', 'counter', [
    ['', stats.fillErrors],
  ]);
  metric(
    'tix_page_cache_fills_suppressed_total',
    'Misses rendered normally without a fill because a fill of the page failed moments ago.',
    'counter',
    [['', stats.fillsSuppressed]],
  );
  metric(
    'tix_page_cache_not_stored_total',
    'Renders served but not stored (not cacheable, sale boundary or invalidated meanwhile).',
    'counter',
    [['', stats.notStored]],
  );
  metric('tix_page_cache_flushes_total', 'Full flushes of the HTML page cache.', 'counter', [
    ['', stats.flushes],
  ]);
  return `${lines.join('\n')}\n`;
}
