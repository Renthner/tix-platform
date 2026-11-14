import { expect, test, type Browser, type Page } from '@playwright/test';
import { EVENT_SLUG } from './helpers';

// Shop pages are served from the shop data cache (docs/ARCHITECTURE.md). Admin edits must show on
// the very next page load of a visitor; live state must never lag. Runs with the stored admin
// session; visitors are fresh contexts without cookies.

async function eventId(page: Page): Promise<string> {
  await page.goto('/admin/events');
  const link = page.locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' }).first();
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec((await link.getAttribute('href')) ?? '')?.[1];
  expect(id, `event id of ${EVENT_SLUG}`).toBeTruthy();
  return id!;
}

async function visitor(browser: Browser, baseURL: string) {
  // Explicitly signed out: with the project's admin storage state a visitor would be a super-admin,
  // who bypasses a paused sale.
  const context = await browser.newContext({
    baseURL,
    locale: 'en-US',
    storageState: { cookies: [], origins: [] },
  });
  return { context, page: await context.newPage() };
}

async function setSubtitle(page: Page, id: string, subtitle: string) {
  await page.goto(`/admin/events/${id}`);
  const form = page.locator('form').filter({ has: page.locator('#subtitle') });
  await form.locator('#subtitle').fill(subtitle);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('button', { name: 'Save' })).toBeEnabled();
}

async function setPaused(page: Page, id: string, paused: boolean) {
  await page.goto(`/admin/events/${id}/sales`);
  const toggle = page.getByRole('switch', { name: /Pause sales/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== String(paused)) await toggle.click();
  const form = page.locator('form').filter({ has: toggle });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('button', { name: 'Save' })).toBeEnabled();
}

test('a subtitle edit in the admin shows on the next page load of a visitor', async ({
  page,
  browser,
  baseURL,
}) => {
  const base = baseURL ?? 'http://localhost:18090';
  const id = await eventId(page);
  const original = await (async () => {
    await page.goto(`/admin/events/${id}`);
    return page.locator('#subtitle').inputValue();
  })();
  const fresh = `Live data ${Date.now()}`;
  const v = await visitor(browser, base);
  try {
    // Warm the cache with the old content first.
    await v.page.goto(`/events/${EVENT_SLUG}`);
    await expect(v.page.getByText(fresh)).toHaveCount(0);

    await setSubtitle(page, id, fresh);
    await v.page.goto(`/events/${EVENT_SLUG}`);
    await expect(v.page.getByText(fresh).first()).toBeVisible({ timeout: 5_000 });
    // The shop home lists it too.
    await v.page.goto('/');
    await expect(v.page.getByText(fresh).first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await setSubtitle(page, id, original);
    await v.context.close();
  }
  const back = await visitor(browser, base);
  await back.page.goto(`/events/${EVENT_SLUG}`);
  await expect(back.page.getByText(fresh)).toHaveCount(0);
  await back.context.close();
});

test('pausing sales shows at once on the home page and the event page, resuming restores it', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? 'http://localhost:18090';
  const id = await eventId(page);
  const v = await visitor(browser, base);
  const card = v.page.getByTestId('event-card').filter({ hasText: 'Demo Concert' });
  try {
    await v.page.goto('/');
    await expect(card.getByText('Paused', { exact: true })).toHaveCount(0);

    await setPaused(page, id, true);
    await v.page.goto('/');
    await expect(card.getByText('Paused', { exact: true })).toBeVisible({ timeout: 5_000 });
    await v.page.goto(`/events/${EVENT_SLUG}`);
    await expect(v.page.getByText(/Ticket sales are paused at the moment/)).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await setPaused(page, id, false);
  }
  await v.page.goto('/');
  await expect(card.getByText('Paused', { exact: true })).toHaveCount(0);
  await v.page.goto(`/events/${EVENT_SLUG}`);
  await expect(v.page.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
  await v.context.close();
});

test('the seat plan is revalidated on every load (ETag) and a held seat stays live', async ({
  page,
  browser,
  baseURL,
}) => {
  const base = baseURL ?? 'http://localhost:18090';
  const id = await eventId(page);
  const first = await page.request.get(`/api/events/${id}/seatmap?locale=en`);
  expect(first.status()).toBe(200);
  expect(first.headers()['cache-control']).toBe('no-cache');
  const etag = first.headers()['etag'];
  expect(etag).toMatch(/^"[\w-]+"$/);
  const again = await page.request.get(`/api/events/${id}/seatmap?locale=en`, {
    headers: { 'if-none-match': etag! },
  });
  expect(again.status()).toBe(304);
  expect(await again.text()).toBe('');
  // Live availability is never cacheable.
  const availability = await page.request.get(`/api/events/${id}/availability`);
  expect(availability.headers()['cache-control']).toContain('no-store');

  // A second visitor sees a seat held by the first one although both pages come from the cache.
  const a = await visitor(browser, base);
  const b = await visitor(browser, base);
  try {
    for (const p of [a.page, b.page]) {
      await p.goto(`/events/${EVENT_SLUG}`);
      await expect(p.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
    }
    const ids = await b.page.$$eval('g[data-seat]', (els) =>
      els.map((e) => e.getAttribute('data-seat') ?? ''),
    );
    // Seats the demo plan does not allow as a plain click (companion seats ...) would stay free:
    // try a few candidates. Indexes above the ranges the other specs hold.
    let taken = false;
    for (const id of ids.slice(250, 256)) {
      await a.page.locator(`g[data-seat="${id}"]`).click({ force: true });
      taken = await expect
        .poll(() => b.page.locator(`g[data-seat="${id}"]`).count(), { timeout: 4_000 })
        .toBe(0)
        .then(
          () => true,
          () => false,
        );
      if (taken) break;
    }
    expect(taken, 'a seat held in browser A disappears in browser B').toBe(true);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
