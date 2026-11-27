import { expect, test, type Page, type PlaywrightTestArgs } from '@playwright/test';
import { EVENT_SLUG } from './helpers';

// HTML page cache for anonymous visitors (apps/web/src/server/page-cache*.ts): hits carry their
// own CSP nonce, keep the session cookie flow, separate theme/notice variants, never serve
// signed-in visitors, flight requests or 404s, and die with admin changes. The file is matched by
// the `shop` (anonymous) and `admin` (signed in) projects; every test only runs in the project it
// belongs to.
//
// The stack runs several web processes with one cache each: a repeated request can land on
// another process, so "becomes a hit" is polled.

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:18090';
const EVENT = `/events/${EVENT_SLUG}`;
const ANON = { cookies: [], origins: [] };

type Playwright = PlaywrightTestArgs['playwright'];
interface Fetched {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const cspNonce = (r: Fetched) =>
  /'nonce-([^']+)'/.exec(r.headers['content-security-policy'] ?? '')?.[1];

/**
 * One GET as a first-time visitor (fresh context, no cookie jar) asking for an HTML document like a
 * browser navigation; `headers` adds cookies or overrides.
 */
async function visit(
  playwright: Playwright,
  path: string,
  headers: Record<string, string> = {},
  maxRedirects = 0,
): Promise<Fetched> {
  const request = await playwright.request.newContext({ baseURL: BASE, storageState: ANON });
  try {
    const r = await request.get(path, {
      headers: { accept: 'text/html,application/xhtml+xml', ...headers },
      maxRedirects,
    });
    return { status: r.status(), headers: r.headers(), body: await r.text() };
  } finally {
    await request.dispose();
  }
}

/** Polls until `path` is answered from the cache; returns that response. */
async function untilHit(
  playwright: Playwright,
  path: string,
  headers: Record<string, string> = {},
): Promise<Fetched> {
  let hit: Fetched | undefined;
  await expect(async () => {
    const r = await visit(playwright, path, headers);
    expect(r.status).toBe(200);
    expect(r.headers['x-tix-page-cache']).toBe('hit');
    hit = r;
  }).toPass({ timeout: 30_000, intervals: [100, 200, 300] });
  return hit!;
}

test.describe('anonymous visitors', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'shop', 'anonymous project only');
  });

  test('a second anonymous request is a hit with a fresh, matching nonce', async ({
    playwright,
  }) => {
    const first = await visit(playwright, EVENT);
    expect(first.status).toBe(200);
    const second = await untilHit(playwright, EVENT);
    expect(second.headers['x-tix-page-cache']).toBe('hit');
    const nonce = cspNonce(second);
    expect(nonce).toBeTruthy();
    expect(nonce).not.toBe(cspNonce(first));
    const scriptNonces = [...second.body.matchAll(/<script[^>]*\snonce="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(scriptNonces.length).toBeGreaterThan(0);
    expect(new Set(scriptNonces)).toEqual(new Set([nonce]));
  });

  test('requests with a query string bypass the cache', async ({ playwright }) => {
    await untilHit(playwright, EVENT);
    for (const query of ['?utm_source=newsletter', '?a=1']) {
      const r = await visit(playwright, `${EVENT}${query}`);
      expect(r.status, query).toBe(200);
      expect(r.headers['x-tix-page-cache'], query).toBe('bypass');
    }
  });

  test('a repeated visit is a hit with its own nonce everywhere', async ({ playwright }) => {
    for (const path of [EVENT, '/', '/de', `/de${EVENT}`]) {
      const first = await visit(playwright, path);
      expect(first.status, path).toBe(200);
      expect(['hit', 'miss']).toContain(first.headers['x-tix-page-cache']);
      const hit = await untilHit(playwright, path);
      const nonce = cspNonce(hit);
      expect(nonce, `CSP nonce of ${path}`).toBeTruthy();
      expect(nonce).not.toBe(cspNonce(first));
      const attrs = [...hit.body.matchAll(/nonce="([^"]*)"/g)].map((m) => m[1]);
      expect(attrs.length, `nonce attributes in ${path}`).toBeGreaterThan(0);
      expect(new Set(attrs)).toEqual(new Set([nonce]));
      // No other response's nonce leaks into this one.
      expect(hit.body.includes(cspNonce(first)!)).toBe(false);
      // Same headers as a normal render (apart from the per-request ones).
      const h = hit.headers;
      expect(h['content-type']).toMatch(/^text\/html/);
      expect(h['cache-control']).toContain('no-store');
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['strict-transport-security']).toBeTruthy();
      expect(h['link'], 'hreflang alternates').toContain('hreflang');
      expect(h['set-cookie'] ?? '', 'session cookie on a first visit').toContain('tix_sid=');
      // The hreflang alternates equal a normal render's. Style preloads appear in the Link header
      // depending on render timing (also between two normal renders); when present they carry
      // this response's nonce.
      const normal = await visit(playwright, path, { cookie: 'tix_customer=not-a-session' });
      expect(normal.headers['x-tix-page-cache']).toBe('bypass');
      const alternates = (r: Fetched) =>
        (r.headers['link'] ?? '')
          .split(/,\s*(?=<)/)
          .filter((l) => l.includes('rel="alternate"'))
          .join(', ');
      expect(alternates(hit)).toBe(alternates(normal));
      for (const m of (h['link'] ?? '').matchAll(/nonce="([^"]*)"/g)) expect(m[1]).toBe(nonce);
    }
  });

  test('a first-time visitor served from the cache keeps one session id', async ({
    browser,
    playwright,
  }) => {
    await untilHit(playwright, EVENT);
    let page: Page | undefined;
    let sid = '';
    await expect(async () => {
      await page?.context().close();
      const ctx = await browser.newContext({ storageState: ANON, baseURL: BASE });
      page = await ctx.newPage();
      const response = await page.goto(EVENT);
      expect(response?.headers()['x-tix-page-cache']).toBe('hit');
      sid = /tix_sid=([^;]+)/.exec((await response!.allHeaders())['set-cookie'] ?? '')?.[1] ?? '';
      expect(sid).not.toBe('');
    }).toPass({ timeout: 30_000 });

    const p = page!;
    try {
      const sidOf = (cookie: string | null) => /tix_sid=([^;]+)/.exec(cookie ?? '')?.[1];
      const enter = p.waitForRequest((r) => /\/api\/events\/[^/]+\/enter$/.test(r.url()), {
        timeout: 30_000,
      });
      const token = p.waitForRequest((r) => r.url().endsWith('/api/session/realtime-token'), {
        timeout: 30_000,
      });
      // The listeners may come after the calls of the first load: reload keeps the same jar.
      await p.reload();
      expect(sidOf(await (await enter).headerValue('cookie'))).toBe(sid);
      expect(sidOf(await (await token).headerValue('cookie'))).toBe(sid);
      const jar = await p.context().cookies();
      expect(jar.filter((c) => c.name === 'tix_sid').map((c) => c.value)).toEqual([sid]);
    } finally {
      await p.context().close();
    }
  });

  test('theme and cookie notice are separate cache variants', async ({ playwright }) => {
    const dark = await untilHit(playwright, EVENT, { cookie: 'tix_theme=dark' });
    const light = await untilHit(playwright, EVENT, { cookie: 'tix_theme=light' });
    expect(dark.body).toMatch(/<html[^>]*data-theme="dark"/);
    expect(light.body).toMatch(/<html[^>]*data-theme="light"/);

    const shown = await untilHit(playwright, '/');
    const dismissed = await untilHit(playwright, '/', { cookie: 'tix_cookie_notice=1' });
    expect(shown.body).toContain('data-testid="cookie-notice"');
    expect(dismissed.body).not.toContain('data-testid="cookie-notice"');
  });

  test('customers, flight requests and non-document fetches bypass the cache', async ({
    playwright,
  }) => {
    await untilHit(playwright, EVENT);
    const customer = await visit(playwright, EVENT, { cookie: 'tix_customer=not-a-session' });
    expect(customer.status).toBe(200);
    expect(customer.headers['x-tix-page-cache']).toBe('bypass');

    // App Router navigation: Next.js hides RSC from the proxy; it must still get flight data
    // (after Next's redirect that adds the `_rsc` cache-busting parameter).
    const rsc = await visit(playwright, EVENT, { accept: '*/*', rsc: '1' }, 2);
    expect(rsc.headers['x-tix-page-cache']).toBe('bypass');
    expect(rsc.headers['content-type']).toContain('text/x-component');
    const fetchLike = await visit(playwright, EVENT, { 'sec-fetch-dest': 'empty' });
    expect(fetchLike.headers['x-tix-page-cache']).toBe('bypass');
  });

  test('an unknown event is a 404 every time and never cached', async ({ playwright }) => {
    // Concurrent first requests share one 404 render (own nonce each), later ones render again.
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => visit(playwright, '/events/no-such-event-e2e')),
    );
    for (let i = 0; i < 3; i++) burst.push(await visit(playwright, '/events/no-such-event-e2e'));
    for (const r of burst) {
      expect(r.status).toBe(404);
      expect(r.headers['x-tix-page-cache']).not.toBe('hit');
      const nonce = cspNonce(r);
      for (const m of r.body.matchAll(/nonce="([^"]*)"/g)) expect(m[1]).toBe(nonce);
    }
  });
});

test.describe('signed-in admin', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'admin', 'signed-in project only');
  });

  test('the admin bypasses the cache', async ({ page }) => {
    const response = await page.goto(EVENT);
    expect(response?.headers()['x-tix-page-cache']).toBe('bypass');
    const home = await page.goto('/');
    expect(home?.headers()['x-tix-page-cache']).toBe('bypass');
  });

  test('an event edit is visible on the very next anonymous request', async ({
    page,
    playwright,
  }) => {
    await page.goto('/admin/events');
    const href = await page
      .locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' })
      .first()
      .getAttribute('href');
    const id = /\/admin\/events\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
    expect(id, 'demo event id').toBeTruthy();
    const details = `/admin/events/${id}/details`;

    await page.goto(details);
    const field = page.locator('#subtitle');
    const original = await field.inputValue();
    const marker = `Cached subtitle check ${Date.now()}`;
    const save = async (value: string) => {
      await page.goto(details);
      await field.fill(value);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(async () => {
        await page.goto(details);
        await expect(field).toHaveValue(value, { timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
    };
    try {
      await untilHit(playwright, EVENT);
      await save(marker);
      const next = await visit(playwright, EVENT);
      expect(next.status).toBe(200);
      expect(next.body).toContain(marker);
      expect(next.headers['x-tix-page-cache']).not.toBe('hit');
    } finally {
      await save(original);
    }
  });
});
