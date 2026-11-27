// HTML page cache: key, eligibility, nonce replacement, single-flight, caps and the sale-boundary
// rule (run via `pnpm --filter @tix/web test`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FILL_FAILURE_BACKOFF_MS,
  MAX_CACHEABLE_PATH_LENGTH,
  MIN_ENTRY_LIFETIME_MS,
  PAGE_CACHE_FILL_ID_HEADER,
  PageCacheStore,
  bypassReason,
  cacheablePage,
  entryExpiry,
  hasErroredBoundary,
  isBotUserAgent,
  joinWithNonce,
  nextBoundary,
  nonceFromCsp,
  pageBytes,
  pageCacheConfig,
  pageCacheKey,
  renderPageCachePrometheus,
  reportPageCacheBoundary,
  servedHeaders,
  splitOnNonce,
  takePageCacheHint,
  withPageCacheFallback,
  type FillResult,
  type KeyParts,
  type PageCacheSync,
  type RequestFacts,
} from '../src/server/page-cache.ts';

const LOCALES = ['en', 'de'];
const NONCE = 'A'.repeat(48);

function facts(over: Partial<RequestFacts> = {}): RequestFacts {
  return {
    method: 'GET',
    headerNames: ['host', 'accept', 'cookie'],
    cookieNames: ['tix_sid', 'tix_theme'],
    searchParams: new URLSearchParams(),
    pathname: '/events/demo',
    isBot: false,
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    secFetchDest: 'document',
    ...over,
  };
}

function key(over: Partial<KeyParts> = {}): string {
  return pageCacheKey({
    host: 'shop.example.org',
    forwardedHost: '',
    forwardedProto: '',
    forwardedPort: '',
    proto: 'http',
    locale: 'en',
    defaultLocale: 'en',
    pathname: '/events/demo',
    theme: null,
    noticeDismissed: false,
    ...over,
  });
}

function html(body: string, over: Partial<FillResult> = {}): FillResult {
  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body,
    headers: [['content-type', 'text/html; charset=utf-8']],
    nonce: NONCE,
    hint: { boundary: null },
    ...over,
  };
}

function sync(): PageCacheSync & { gen: number; ok: boolean } {
  const s = {
    gen: 0,
    ok: true,
    synced: () => s.ok,
    generation: () => s.gen,
  };
  return s;
}

function store(over: { now?: () => number; maxBytes?: number; maxEntries?: number } = {}) {
  const s = sync();
  const cache = new PageCacheStore({
    maxBytes: over.maxBytes ?? 1024 * 1024,
    maxEntries: over.maxEntries ?? 100,
    now: over.now,
    sync: s,
  });
  return { cache, sync: s };
}

test('configuration: default 5 s / 32 MB, max 60 s, 0 switches off, invalid values fall back', () => {
  assert.equal(pageCacheConfig({}).ttlMs, 5_000);
  assert.equal(pageCacheConfig({}).maxBytes, 32 * 1024 * 1024);
  assert.equal(pageCacheConfig({ TIX_PAGE_CACHE_TTL_MS: '0' }).ttlMs, 0);
  assert.equal(pageCacheConfig({ NODE_ENV: 'development' }).ttlMs, 0, 'off under next dev');
  assert.equal(
    pageCacheConfig({ NODE_ENV: 'development', TIX_PAGE_CACHE_TTL_MS: '3000' }).ttlMs,
    3_000,
  );
  assert.equal(pageCacheConfig({ TIX_PAGE_CACHE_TTL_MS: '2500' }).ttlMs, 2_500);
  assert.equal(pageCacheConfig({ TIX_PAGE_CACHE_TTL_MS: 'abc' }).ttlMs, 5_000);
  assert.equal(pageCacheConfig({ TIX_PAGE_CACHE_TTL_MS: '-1' }).ttlMs, 5_000);
  // Capped at 60 s (clamped, not ignored).
  assert.equal(pageCacheConfig({ TIX_PAGE_CACHE_TTL_MS: '60000' }).ttlMs, 60_000);
  assert.equal(pageCacheConfig({ TIX_PAGE_CACHE_TTL_MS: '600000' }).ttlMs, 60_000);
  assert.equal(pageCacheConfig({ TIX_PAGE_CACHE_MAX_MB: '8' }).maxBytes, 8 * 1024 * 1024);
});

test('only the start page and event pages of a known locale are cacheable', () => {
  assert.deepEqual(cacheablePage('/en', LOCALES), { kind: 'start', locale: 'en' });
  assert.deepEqual(cacheablePage('/de/events/demo-concert', LOCALES), {
    kind: 'event',
    locale: 'de',
  });
  for (const path of [
    '/',
    '/fr',
    '/en/',
    '/en/cart',
    '/en/checkout',
    '/en/events',
    '/en/events/demo/extra',
    '/en/admin',
    '/en/orders/TIX-1',
  ]) {
    assert.equal(cacheablePage(path, LOCALES), null, path);
  }
});

test('bypass: HEAD, router/RSC requests, server actions, personal cookies, bots', () => {
  assert.equal(bypassReason(facts()), null);
  assert.equal(bypassReason(facts({ method: 'HEAD' })), 'method');
  for (const h of ['rsc', 'next-action', 'next-router-state-tree', 'next-router-prefetch']) {
    assert.equal(bypassReason(facts({ headerNames: ['host', h] })), 'router', h);
  }
  assert.equal(bypassReason(facts({ searchParams: new URLSearchParams('_rsc=x1') })), 'router');
  for (const c of [
    'tix_admin',
    'tix_admin_2fa',
    'tix_admin_pk',
    'tix_admin_queue_test',
    'tix_customer',
  ]) {
    assert.equal(bypassReason(facts({ cookieNames: ['tix_sid', c] })), 'personal', c);
  }
  // Harmless cookies (queue pass, locale, notice, foreign ones) do not bypass.
  assert.equal(
    bypassReason(facts({ cookieNames: ['tix_qp_abc', 'tix_locale', 'tix_cookie_notice', '_x'] })),
    null,
  );
  assert.equal(bypassReason(facts({ isBot: true })), 'bot');
});

test('bypass: any query string (tracking parameters included) and overlong paths', () => {
  for (const q of ['a=1', 'utm_source=newsletter', 'fbclid=abc', 'expired=1', 'x']) {
    assert.equal(bypassReason(facts({ searchParams: new URLSearchParams(q) })), 'query', q);
  }
  assert.equal(
    bypassReason(facts({ pathname: `/events/${'x'.repeat(MAX_CACHEABLE_PATH_LENGTH)}` })),
    'long-path',
  );
  assert.equal(bypassReason(facts({ pathname: `/events/${'x'.repeat(100)}` })), null);
});

test('only HTML document requests are served (Next.js hides RSC headers from the proxy)', () => {
  assert.equal(bypassReason(facts({ secFetchDest: null })), null);
  assert.equal(bypassReason(facts({ accept: 'text/html' })), null);
  // App Router flight fetches: no Accept header (fetch default), Sec-Fetch-Dest "empty".
  assert.equal(bypassReason(facts({ accept: '*/*', secFetchDest: 'empty' })), 'not-document');
  assert.equal(bypassReason(facts({ accept: '*/*', secFetchDest: null })), 'not-document');
  assert.equal(bypassReason(facts({ accept: null })), 'not-document');
  assert.equal(bypassReason(facts({ secFetchDest: 'empty' })), 'not-document');
  assert.equal(bypassReason(facts({ secFetchDest: 'iframe' })), 'not-document');
  assert.equal(bypassReason(facts({ accept: 'application/xtext/htmlx' })), 'not-document');
});

test('key separates every render input (incl. Host and both forwarded headers)', () => {
  const base = key();
  assert.equal(key(), base);
  assert.equal(key({ host: 'SHOP.example.org' }), base, 'host is case-insensitive');
  for (const over of [
    { host: 'other.example.org' },
    { forwardedHost: 'shop.example.org' },
    { forwardedHost: 'other.example.org' },
    { forwardedProto: 'https' },
    { forwardedPort: '443' },
    { proto: 'https' },
    { locale: 'de' },
    { defaultLocale: 'de' },
    { pathname: '/events/other' },
    { theme: 'dark' },
    { theme: 'light' },
    { theme: 'system' },
    { noticeDismissed: true },
  ] satisfies Partial<KeyParts>[]) {
    assert.notEqual(key(over), base, JSON.stringify(over));
  }
});

test('nonce: read from the CSP header, replaced everywhere in the body', () => {
  const csp = `default-src 'self'; script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`;
  assert.equal(nonceFromCsp(csp), NONCE);
  assert.equal(nonceFromCsp("default-src 'self'"), null);
  assert.equal(nonceFromCsp(null), null);
  const body = `<script nonce="${NONCE}"></script>{"nonce":"${NONCE}"}<p>${NONCE}</p>`;
  const parts = splitOnNonce(body, NONCE);
  const other = 'B'.repeat(48);
  const out = joinWithNonce(parts, other);
  assert.equal(out.includes(NONCE), false);
  assert.equal(out.split(other).length - 1, 3);
  assert.equal(joinWithNonce(parts, NONCE), body);
});

test('nonce: header values of a stored render (style preload links) get the new nonce', async () => {
  const { cache } = store();
  const link = `</a.css>; rel=preload; as="style"; nonce="${NONCE}"`;
  const fill = async () =>
    html('<p/>', {
      headers: [
        ['content-type', 'text/html; charset=utf-8'],
        ['link', link],
      ],
    });
  await cache.lookup('k', 5_000, fill);
  const { page, outcome } = await cache.lookup('k', 5_000, fill);
  assert.equal(outcome, 'hit');
  const other = 'C'.repeat(48);
  assert.deepEqual(servedHeaders(page!, other), [
    ['content-type', 'text/html; charset=utf-8'],
    ['link', `</a.css>; rel=preload; as="style"; nonce="${other}"`],
  ]);
});

test('single-flight: concurrent misses share one render, later requests hit', async () => {
  const { cache } = store();
  let fills = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fill = async () => {
    fills += 1;
    await gate;
    return html(`<html nonce="${NONCE}">x</html>`);
  };
  const pending = Array.from({ length: 50 }, () => cache.lookup('k', 5_000, fill));
  release();
  const results = await Promise.all(pending);
  assert.equal(fills, 1);
  assert.equal(results.filter((r) => r.outcome === 'miss').length, 1);
  assert.equal(results.filter((r) => r.outcome === 'coalesced').length, 49);
  assert.ok(
    results.every((r) => r.page && joinWithNonce(r.page.parts, 'n') === '<html nonce="n">x</html>'),
  );
  const again = await cache.lookup('k', 5_000, fill);
  assert.equal(again.outcome, 'hit');
  assert.equal(fills, 1);
  const s = cache.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.coalesced, 49);
  assert.equal(s.entries, 1);
});

test('TTL: an entry expires and is rendered again', async () => {
  let now = 1_000_000;
  const { cache } = store({ now: () => now });
  let fills = 0;
  const fill = async () => {
    fills += 1;
    return html(`<p>${fills}</p>`);
  };
  await cache.lookup('k', 5_000, fill);
  now += 4_999;
  assert.equal((await cache.lookup('k', 5_000, fill)).outcome, 'hit');
  now += 2;
  assert.equal((await cache.lookup('k', 5_000, fill)).outcome, 'miss');
  assert.equal(fills, 2);
});

test('not stored: non-200, non-HTML, no nonce, no page hint, errored boundary', async () => {
  // shared = handed to the requests of this render (HTML with a nonce, 200 or an error status).
  const cases: { result: FillResult; shared: boolean }[] = [
    { result: html('<p>404</p>', { status: 404 }), shared: true },
    { result: html('<p>500</p>', { status: 500 }), shared: true },
    { result: html('', { status: 307 }), shared: false },
    { result: html('{}', { contentType: 'application/json' }), shared: false },
    { result: html('<p/>', { nonce: null }), shared: false },
    { result: html('<p/>', { hint: undefined }), shared: true },
    { result: html('<div><!--$!--><template data-dgst="x"></template></div>'), shared: true },
    { result: html('<script>$RX("B:1","NEXT_HTTP_ERROR_FALLBACK;404")</script>'), shared: true },
  ];
  for (const { result, shared } of cases) {
    const { cache } = store();
    let fills = 0;
    const fill = async () => {
      fills += 1;
      return result;
    };
    const label = `${result.status} ${result.contentType} ${result.body.slice(0, 30)}`;
    const first = await cache.lookup('k', 5_000, fill);
    const second = await cache.lookup('k', 5_000, fill);
    assert.equal(fills, 2, `rendered again: ${label}`);
    assert.equal(second.outcome, 'miss', label);
    assert.equal(!!first.page, shared, label);
    if (first.page) assert.equal(first.page.status, result.status, label);
    assert.equal(cache.stats().entries, 0, label);
  }
});

test('a non-200 render is shared with every waiter (one render), never stored', async () => {
  const { cache } = store();
  let fills = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fill = async () => {
    fills += 1;
    await gate;
    return html(`<p nonce="${NONCE}">not found</p>`, { status: 404 });
  };
  const pending = Array.from({ length: 20 }, () => cache.lookup('k', 5_000, fill));
  release();
  const results = await Promise.all(pending);
  assert.equal(fills, 1);
  for (const r of results) {
    assert.equal(r.page?.status, 404);
    assert.equal(joinWithNonce(r.page!.parts, 'n'), '<p nonce="n">not found</p>');
  }
  assert.equal(cache.stats().entries, 0);
});

test('a failed fill suppresses new fills of the key for a short backoff', async () => {
  for (const failure of [null, new Error('boom')]) {
    let now = 2_000_000;
    const { cache } = store({ now: () => now });
    let fills = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fail = true;
    const fill = async () => {
      fills += 1;
      await gate;
      if (!fail) return html('<p/>');
      if (failure) throw failure;
      return null;
    };
    // The initiating request and its waiters all fall back (page null) after ONE fill.
    const wave = Array.from({ length: 10 }, () => cache.lookup('k', 5_000, fill));
    release();
    const results = await Promise.all(wave);
    assert.equal(fills, 1);
    assert.ok(results.every((r) => r.page === null));
    // The next wave inside the backoff renders normally without starting a fill.
    now += FILL_FAILURE_BACKOFF_MS - 1;
    for (let i = 0; i < 5; i += 1) {
      const r = await cache.lookup('k', 5_000, fill);
      assert.equal(r.page, null);
      assert.equal(r.outcome, 'miss');
    }
    assert.equal(fills, 1);
    assert.equal(cache.stats().fillsSuppressed, 5);
    assert.equal(cache.stats().fillErrors, 1);
    // Other keys are not affected.
    assert.ok((await cache.lookup('other', 5_000, async () => html('<p/>'))).page);
    // After the backoff the next miss fills again.
    now += 1;
    fail = false;
    const again = await cache.lookup('k', 5_000, fill);
    assert.equal(fills, 2);
    assert.ok(again.page);
  }
});

test('errored boundary detection (React markers only)', () => {
  assert.equal(hasErroredBoundary('<main><p>ok</p></main>'), false);
  assert.equal(hasErroredBoundary('<!--$--><p>ok</p><!--/$-->'), false);
  assert.equal(hasErroredBoundary('<!--$!--><template data-dgst="1"></template><!--/$-->'), true);
  assert.equal(hasErroredBoundary('<script>$RX("B:0","123")</script>'), true);
  assert.equal(hasErroredBoundary('<template data-rxi="" data-bid="B:0"></template>'), true);
  // Escaped page text cannot fake the markers.
  assert.equal(hasErroredBoundary('<p>&lt;!--$!--&gt; $RX(&quot;</p>'), false);
});

test('bytes: two per UTF-16 code unit of body and headers', () => {
  assert.equal(pageBytes('abc', []), 6);
  assert.equal(pageBytes('äö', [['link', 'x']]), 2 * (2 + 4 + 1));
});

test('bots: vendored Next.js crawler list', () => {
  for (const ua of [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; AdsBot-Google; +http://www.google.com/adsbot.html)',
    'WhatsApp/2.23.20.0',
  ]) {
    assert.equal(isBotUserAgent(ua), true, ua);
  }
  for (const ua of [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'tix-page-cache',
    '',
  ]) {
    assert.equal(isBotUserAgent(ua), false, ua);
  }
});

test('proxy guard: a throwing cache step falls back and is reported', async () => {
  const reported: unknown[] = [];
  const out = await withPageCacheFallback(
    async () => {
      throw new Error('boom');
    },
    'fallback',
    (err) => reported.push(err),
  );
  assert.equal(out, 'fallback');
  assert.equal(reported.length, 1);
  // A throwing reporter does not break it either.
  const quiet = await withPageCacheFallback(
    () => Promise.reject(new Error('x')),
    1,
    () => {
      throw new Error('log down');
    },
  );
  assert.equal(quiet, 1);
  assert.equal(
    await withPageCacheFallback(
      async () => 'ok',
      'fallback',
      () => {},
    ),
    'ok',
  );
});

test('sale boundary: expiry is capped, a boundary that is too close prevents storing', async () => {
  const now = 5_000_000;
  assert.equal(entryExpiry(now, 5_000, null), now + 5_000);
  assert.equal(entryExpiry(now, 5_000, now + 2_000), now + 2_000);
  assert.equal(entryExpiry(now, 5_000, now + 60_000), now + 5_000);
  assert.equal(entryExpiry(now, 5_000, now + MIN_ENTRY_LIFETIME_MS - 1), null);
  assert.equal(entryExpiry(now, 0, null), null);

  assert.equal(nextBoundary([], now), null);
  assert.equal(
    nextBoundary(
      [null, undefined, new Date(now - 1), new Date(now + 9_000), new Date(now + 3_000)],
      now,
    ),
    now + 3_000,
  );

  let t = now;
  const { cache } = store({ now: () => t });
  const fill = async () => html('<p/>', { hint: { boundary: now + 2_000 } });
  await cache.lookup('k', 5_000, fill);
  t = now + 1_999;
  assert.equal((await cache.lookup('k', 5_000, fill)).outcome, 'hit');
  t = now + 2_000;
  assert.equal((await cache.lookup('k', 5_000, fill)).outcome, 'miss');
});

test('page hint travels from the render to the fill by fill id', () => {
  const id = 'fill-123';
  reportPageCacheBoundary({ get: () => null }, [new Date(Date.now() + 60_000)]);
  assert.equal(takePageCacheHint(id), undefined);
  const at = Date.now() + 60_000;
  reportPageCacheBoundary({ get: (name) => (name === PAGE_CACHE_FILL_ID_HEADER ? id : null) }, [
    new Date(at),
    null,
  ]);
  assert.deepEqual(takePageCacheHint(id), { boundary: at });
  assert.equal(takePageCacheHint(id), undefined, 'taken once');
  reportPageCacheBoundary({ get: () => id }, []);
  assert.deepEqual(takePageCacheHint(id), { boundary: null });
});

test('invalidation: a generation change flushes, a render running meanwhile is not stored', async () => {
  const { cache, sync: s } = store();
  let fills = 0;
  const fill = async () => {
    fills += 1;
    return html(`<p>${fills}</p>`);
  };
  await cache.lookup('k', 5_000, fill);
  s.gen += 1;
  assert.equal((await cache.lookup('k', 5_000, fill)).outcome, 'miss');
  assert.equal(fills, 2);

  // Invalidated while rendering: served to its callers, not stored.
  const { cache: c2, sync: s2 } = store();
  const r = await c2.lookup('k', 5_000, async () => {
    s2.gen += 1;
    return html('<p>stale</p>');
  });
  assert.ok(r.page);
  assert.equal(c2.stats().entries, 0);

  // Not stored while the subscription is down.
  const { cache: c3, sync: s3 } = store();
  s3.ok = false;
  await c3.lookup('k', 5_000, async () => html('<p/>'));
  assert.equal(c3.stats().entries, 0);
  assert.equal(c3.usable, false);
});

test('caps: entry count and bytes evict the least recently used entries', async () => {
  const { cache } = store({ maxEntries: 2 });
  for (const k of ['a', 'b', 'c']) await cache.lookup(k, 5_000, async () => html(`<p>${k}</p>`));
  assert.equal(cache.stats().entries, 2);
  assert.equal((await cache.lookup('a', 5_000, async () => html('<p>a</p>'))).outcome, 'miss');

  // Charged 2 bytes per code unit of body + headers: 60 + 36 units = 192 bytes per entry.
  const { cache: small } = store({ maxBytes: 300 });
  await small.lookup('x', 5_000, async () => html('x'.repeat(60)));
  assert.equal(
    small.stats().bytes,
    2 * (60 + 'content-type'.length + 'text/html; charset=utf-8'.length),
  );
  await small.lookup('y', 5_000, async () => html('y'.repeat(60)));
  assert.equal(small.stats().entries, 1);
  assert.ok(small.stats().bytes <= 300);
  // Larger than the whole budget: served, never stored.
  const big = await small.lookup('z', 5_000, async () => html('z'.repeat(200)));
  assert.ok(big.page);
  assert.equal(small.stats().entries, 1);
});

test('prometheus lines', () => {
  assert.equal(renderPageCachePrometheus(null), '');
  const { cache } = store();
  const text = renderPageCachePrometheus(cache.stats());
  assert.match(text, /^tix_page_cache_requests_total\{result="hit"\} 0$/m);
  assert.match(text, /^tix_page_cache_entries 0$/m);
});
