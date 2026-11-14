import { expect, test, type Page } from '@playwright/test';
import { AUTH_FILE, EVENT_SLUG } from './helpers';

test('robots.txt hides the private areas and points to the sitemap', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.ok()).toBe(true);
  const body = await res.text();
  expect(body).toMatch(/^Disallow: \/admin$/m);
  expect(body).toMatch(/^Disallow: \/checkout$/m);
  expect(body).toMatch(/^Disallow: \/de\/admin$/m);
  expect(body).toMatch(/^Disallow: \/api\/$/m);
  expect(body).toMatch(/^Allow: \/api\/media\/$/m);
  expect(body).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
});

test('sitemap.xml lists the demo event with hreflang alternates', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.ok()).toBe(true);
  const xml = await res.text();
  expect(xml).toContain(`/events/${EVENT_SLUG}</loc>`);
  expect(xml).toContain('hreflang="de"');
  expect(xml).toContain('hreflang="x-default"');
  expect(xml).toContain('/cookies</loc>');
  expect(xml).not.toContain('/admin');
});

test('web manifest carries the shop name and theme colour', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.name).toBeTruthy();
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test('event page has canonical, hreflang, Open Graph and valid Event JSON-LD', async ({ page }) => {
  await page.goto(`/events/${EVENT_SLUG}`);
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(canonical).toMatch(new RegExp(`/events/${EVENT_SLUG}$`));
  const langs = await page
    .locator('link[rel="alternate"][hreflang]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('hreflang')));
  expect(langs).toEqual(expect.arrayContaining(['en', 'de', 'x-default']));
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    /Demo Concert/,
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', canonical!);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveCount(1);
  // Brand colour (light) and dark page background (dark) for the browser chrome (media specific).
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);

  const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
  const data = JSON.parse(raw ?? '');
  expect(data['@type']).toBe('Event');
  expect(data.name).toBe('Demo Concert');
  expect(data.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  expect(data.eventStatus).toBe('https://schema.org/EventScheduled');
  expect(data.location['@type']).toBe('Place');
  expect(data.offers['@type']).toBe('AggregateOffer');
  expect(Number(data.offers.lowPrice)).toBeLessThanOrEqual(Number(data.offers.highPrice));
  expect(data.offers.priceCurrency).toMatch(/^[A-Z]{3}$/);
});

test('private pages stay noindex', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

// ─── Settings → SEO (admin-controlled; global state, restored at the end) ──────────────────────

test.describe('SEO settings', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: AUTH_FILE });

  /** Saves Settings → SEO; `fill` maps input names to values, `indexing` flips the switch. */
  async function saveSeo(page: Page, opts: { indexing?: boolean; fill?: Record<string, string> }) {
    await page.goto('/admin/settings/seo');
    const form = page.locator('form').filter({ has: page.locator('#titleTemplate') });
    if (opts.indexing !== undefined) {
      const toggle = form.getByRole('switch').first();
      if ((await toggle.getAttribute('aria-checked')) !== String(opts.indexing))
        await toggle.click();
    }
    for (const [name, value] of Object.entries(opts.fill ?? {})) {
      await form.locator(`[name="${name}"]`).fill(value);
    }
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
  }

  async function demoEventId(page: Page): Promise<string> {
    await page.goto('/admin/events');
    const link = page.locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' }).first();
    const href = (await link.getAttribute('href')) ?? '';
    const id = /\/admin\/events\/([0-9a-f-]{36})/.exec(href)?.[1];
    expect(id, 'event id').toBeTruthy();
    return id!;
  }

  async function setEventNoindex(page: Page, id: string, value: boolean) {
    await page.goto(`/admin/events/${id}/sales`);
    const toggle = page.getByRole('switch', { name: /Exclude this event from search engines/ });
    if ((await toggle.getAttribute('aria-checked')) !== String(value)) await toggle.click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
  }

  test.afterAll(async ({ browser, baseURL }) => {
    // Restore the defaults so the following specs see an indexable shop.
    const context = await browser.newContext({ baseURL, storageState: AUTH_FILE });
    const page = await context.newPage();
    try {
      await saveSeo(page, {
        indexing: true,
        fill: {
          titleTemplate: '%s · {siteTitle}',
          'verification.google': '',
          'verification.bing': '',
          twitterHandle: '',
        },
      });
      const id = await demoEventId(page);
      await setEventNoindex(page, id, false);
    } finally {
      await context.close();
    }
  });

  test('switching indexing off hides the whole shop from search engines, and back on', async ({
    page,
  }) => {
    await saveSeo(page, { indexing: false });

    await expect
      .poll(async () => (await page.request.get('/robots.txt')).text(), { timeout: 20_000 })
      .toMatch(/^Disallow: \/$/m);
    const robots = await (await page.request.get('/robots.txt')).text();
    expect(robots).toMatch(/^User-Agent: \*$/im);
    expect(robots).not.toMatch(/sitemap/i);
    expect((await page.request.get('/sitemap.xml')).status()).toBe(404);

    // Header (proxy, own settings cache) and meta tag on the home page and an event page.
    await expect
      .poll(async () => (await page.request.get('/')).headers()['x-robots-tag'], {
        timeout: 20_000,
      })
      .toBe('noindex, nofollow');
    for (const path of ['/', `/events/${EVENT_SLUG}`]) {
      const res = await page.request.get(path);
      expect(res.headers()['x-robots-tag'], path).toBe('noindex, nofollow');
      await page.goto(path);
      await expect(page.locator('meta[name="robots"]'), path).toHaveAttribute('content', /noindex/);
    }
    // No structured data while indexing is off (the page loaded last is the event page).
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);

    await saveSeo(page, { indexing: true });
    await expect
      .poll(async () => (await page.request.get('/robots.txt')).text(), { timeout: 20_000 })
      .toMatch(/^Sitemap: /m);
    expect((await page.request.get('/sitemap.xml')).status()).toBe(200);
    await expect
      .poll(async () => (await page.request.get('/')).headers()['x-robots-tag'], {
        timeout: 20_000,
      })
      .toBeUndefined();
  });

  test('an event can be excluded from search engines on its own', async ({ page }) => {
    const id = await demoEventId(page);
    await setEventNoindex(page, id, true);

    await expect
      .poll(async () => (await page.request.get('/sitemap.xml')).text(), { timeout: 20_000 })
      .not.toContain(`/events/${EVENT_SLUG}</loc>`);
    await page.goto(`/events/${EVENT_SLUG}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
    // The rest of the shop stays indexable.
    await page.goto('/');
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

    await setEventNoindex(page, id, false);
    await expect
      .poll(async () => (await page.request.get('/sitemap.xml')).text(), { timeout: 20_000 })
      .toContain(`/events/${EVENT_SLUG}</loc>`);
    await page.goto(`/events/${EVENT_SLUG}`);
    await expect(page.locator('script[type="application/ld+json"]').first()).toBeAttached();
  });

  test('site verification and Twitter handle reach the home page, a bad title pattern is rejected', async ({
    page,
  }) => {
    await saveSeo(page, {
      fill: {
        'verification.google': 'e2e-google-token-12345',
        'verification.bing': 'E2EBING0123456789',
        twitterHandle: 'e2e_club',
      },
    });
    await expect
      .poll(
        async () => {
          await page.goto('/');
          return page.locator('meta[name="google-site-verification"]').count();
        },
        { timeout: 20_000 },
      )
      .toBe(1);
    await expect(page.locator('meta[name="google-site-verification"]')).toHaveAttribute(
      'content',
      'e2e-google-token-12345',
    );
    await expect(page.locator('meta[name="msvalidate.01"]')).toHaveAttribute(
      'content',
      'E2EBING0123456789',
    );
    await expect(page.locator('meta[name="twitter:site"]')).toHaveAttribute('content', '@e2e_club');

    // A title pattern without the page title token is rejected and keeps the input.
    await page.goto('/admin/settings/seo');
    const form = page.locator('form').filter({ has: page.locator('#titleTemplate') });
    // Labels resolve their placeholders (no raw message keys).
    await expect(form.getByText('Site title (English)')).toBeVisible();
    await form.locator('#titleTemplate').fill('only the site');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('The pattern must contain %s exactly once.')).toBeVisible();
    await expect(form.locator('#titleTemplate')).toHaveValue('only the site');
  });
});
