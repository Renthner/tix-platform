import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { AUTH_FILE, EVENT_SLUG, waitRealtimeConnected } from './helpers';

/**
 * Waiting-list banner of the event page: its trigger (global default "only when sold out" versus
 * the event's "as soon as nothing can be selected"), the live show/hide from the seat deltas, the
 * "any category" sign-up and the position of the block in the page designer. "Sold out" itself
 * (orders) is covered by the integration test; here every seat of one category is held in another
 * visitor's cart. Serial: one event, one holder, state restored at the end.
 */
test.describe.configure({ mode: 'serial' });

const CATEGORY = 'Category 1';
const banner = (page: Page) => page.locator('[data-slot="waitlist"]');

let eventId = '';
let holder: BrowserContext;
let holderRequest: APIRequestContext;
let held: string[] = [];
let lastFree = '';
const visitors: BrowserContext[] = [];

async function findEventId(page: Page): Promise<string> {
  await page.goto('/admin/events');
  const link = page.locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' }).first();
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec((await link.getAttribute('href')) ?? '')?.[1];
  expect(id, `event id of ${EVENT_SLUG}`).toBeTruthy();
  return id!;
}

/** Signed-out visitor (the admin storage state would make the visitor a super-admin). */
async function newVisitor(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    baseURL,
    locale: 'en-US',
    storageState: { cookies: [], origins: [] },
  });
  visitors.push(context);
  return { context, page: await context.newPage() };
}

async function saveSales(page: Page, field: string) {
  const form = page.locator('form').filter({ has: page.locator(field) });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('button', { name: 'Save' })).toBeEnabled();
}

async function setSales(page: Page, values: { maxTickets?: string; trigger?: string }) {
  await page.goto(`/admin/events/${eventId}/sales`);
  if (values.maxTickets !== undefined)
    await page.locator('#maxTicketsPerOrder').fill(values.maxTickets);
  if (values.trigger !== undefined)
    await page.locator('#waitlistTrigger').selectOption(values.trigger);
  await saveSales(page, '#waitlistTrigger');
}

async function holdSeats(ids: string[]) {
  for (let i = 0; i < ids.length; i += 50) {
    const response = await holderRequest.post(`/api/events/${eventId}/seats`, {
      data: { seatIds: ids.slice(i, i + 50) },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
}

test.beforeAll(async ({ browser, baseURL }) => {
  const admin = await browser.newContext({ baseURL, storageState: AUTH_FILE });
  try {
    const page = await admin.newPage();
    eventId = await findEventId(page);
    // The default limit of 10 tickets per order would stop the holder.
    await setSales(page, { maxTickets: '1000', trigger: 'inherit' });
  } finally {
    await admin.close();
  }
  ({ context: holder } = await newVisitor(browser, baseURL ?? 'http://localhost:18090'));
  holderRequest = holder.request;
  expect((await holderRequest.post(`/api/events/${eventId}/enter`)).ok()).toBe(true);
  const map = await (await holderRequest.get(`/api/events/${eventId}/seatmap?locale=en`)).json();
  const availability = await (
    await holderRequest.get(`/api/events/${eventId}/availability`)
  ).json();
  const category = (map.categories as { id: string; name: string }[]).find(
    (c) => c.name === CATEGORY,
  );
  expect(category, CATEGORY).toBeTruthy();
  const unavailable = new Set<string>([...availability.taken, ...availability.locked]);
  const free: string[] = (map.seats as { i: string; c: string | null; f: number }[])
    // 8 = blocked
    .filter((s) => s.c === category!.id && (s.f & 8) === 0 && !unavailable.has(s.i))
    .map((s) => s.i);
  expect(free.length).toBeGreaterThan(5);
  lastFree = free.at(-1)!;
  held = free.slice(0, -1);
  await holdSeats(held);
});

test.afterAll(async ({ browser, baseURL }) => {
  const all = [...held, lastFree].filter(Boolean);
  for (let i = 0; i < all.length; i += 50) {
    await holderRequest
      ?.delete(`/api/events/${eventId}/seats`, { data: { seatIds: all.slice(i, i + 50) } })
      .catch(() => undefined);
  }
  for (const context of visitors) await context.close().catch(() => undefined);
  const admin = await browser.newContext({ baseURL, storageState: AUTH_FILE });
  try {
    const page = await admin.newPage();
    await setSales(page, { maxTickets: '', trigger: 'inherit' });
  } finally {
    await admin.close();
  }
});

test('while seats are only held in carts the default trigger shows no banner, also live', async ({
  browser,
  baseURL,
}) => {
  const { page } = await newVisitor(browser, baseURL ?? 'http://localhost:18090');
  await page.goto(`/events/${EVENT_SLUG}`);
  await expect(page.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
  await waitRealtimeConnected(page);
  await expect(banner(page)).toHaveCount(0);
  // The last free seat of the category is taken: now every seat is held, still not "sold out".
  await holdSeats([lastFree]);
  await expect(page.locator(`g[data-seat="${lastFree}"]`)).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(3_000);
  await expect(banner(page)).toHaveCount(0);
});

test('with the trigger "as soon as nothing can be selected" the banner shows, live and on load', async ({
  browser,
  baseURL,
}) => {
  const admin = await browser.newContext({ baseURL, storageState: AUTH_FILE });
  try {
    await setSales(await admin.newPage(), { trigger: 'WHEN_UNAVAILABLE' });
  } finally {
    await admin.close();
  }
  const { page } = await newVisitor(browser, baseURL ?? 'http://localhost:18090');
  await page.goto(`/events/${EVENT_SLUG}`);
  await expect(page.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
  await waitRealtimeConnected(page);
  // Server-rendered: one banner, lists the category and offers "any category".
  await expect(banner(page)).toHaveCount(1);
  await expect(banner(page).locator('#waitlist-category option')).toHaveText([
    /Any category/,
    CATEGORY,
  ]);
  await expect(banner(page).locator('#waitlist-category')).toHaveValue(/.+/);

  // Live: a seat comes back → the banner disappears; taken again → it returns (no reload).
  const released = await holderRequest.delete(`/api/events/${eventId}/seats`, {
    data: { seatIds: [lastFree] },
  });
  expect(released.ok()).toBe(true);
  await expect(banner(page)).toHaveCount(0, { timeout: 15_000 });
  await holdSeats([lastFree]);
  await expect(banner(page)).toHaveCount(1, { timeout: 15_000 });
});

test('signing up for "any category" lists as Any in the admin overview', async ({
  browser,
  baseURL,
}) => {
  const { page } = await newVisitor(browser, baseURL ?? 'http://localhost:18090');
  await page.goto(`/events/${EVENT_SLUG}`);
  await expect(banner(page)).toHaveCount(1);
  const email = `any.${Date.now()}@example.org`;
  await banner(page).locator('#waitlist-email').fill(email);
  await banner(page).locator('#waitlist-category').selectOption('');
  await banner(page).getByRole('button', { name: 'Join the waiting list' }).click();
  await expect(page.locator('[data-slot="waitlist-sent"]')).toBeVisible();

  const admin = await browser.newContext({ baseURL, storageState: AUTH_FILE });
  try {
    const adminPage = await admin.newPage();
    await adminPage.goto(`/admin/events/${eventId}/sales`);
    const row = adminPage.locator('[data-slot="waitlist-row"]', { hasText: email });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Any');
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await admin.close();
  }
});

test('the banner block is movable in the page designer and renders at its new position', async ({
  browser: b,
  baseURL,
}) => {
  const admin = await b.newContext({ baseURL, storageState: AUTH_FILE });
  try {
    const page = await admin.newPage();
    const order = async (visitorPage: Page) =>
      visitorPage
        .locator('[data-block]')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.block));
    const { page: visitorPage } = await newVisitor(b, baseURL ?? 'http://localhost:18090');

    // Default (legacy) position: above the seating plan.
    await visitorPage.goto(`/events/${EVENT_SLUG}`);
    await expect(banner(visitorPage)).toHaveCount(1);
    let blocks = await order(visitorPage);
    expect(blocks.indexOf('WAITLIST')).toBeLessThan(blocks.indexOf('SHOP'));

    // Move the block below the seating plan with the row buttons, save, reload.
    await page.goto(`/admin/events/${eventId}/shop-page`);
    const item = page.locator('[data-layout-item="WAITLIST"]');
    await expect(item).toBeVisible();
    const moveDown = async () => {
      const row = page.locator('[data-layout-row]').filter({ has: item });
      await row.getByRole('button', { name: 'Row down' }).click();
    };
    for (let i = 0; i < 3; i += 1) await moveDown();
    await saveSales(page, 'input[name="layout"]');
    await page.reload();
    const rows = await page
      .locator('[data-layout-row]')
      .evaluateAll((els) =>
        els.map((e) =>
          [...e.querySelectorAll('[data-layout-item]')].map((i) =>
            i.getAttribute('data-layout-item'),
          ),
        ),
      );
    const flat = rows.flat();
    expect(flat.indexOf('WAITLIST')).toBeGreaterThan(flat.indexOf('SHOP'));

    await visitorPage.reload();
    await expect(banner(visitorPage)).toHaveCount(1);
    blocks = await order(visitorPage);
    expect(blocks.indexOf('WAITLIST')).toBeGreaterThan(blocks.indexOf('SHOP'));

    // Restore the default position (the block back on top).
    for (let i = 0; i < 3; i += 1) {
      const row = page.locator('[data-layout-row]').filter({ has: item });
      await row.getByRole('button', { name: 'Row up' }).click();
    }
    await saveSales(page, 'input[name="layout"]');
  } finally {
    await admin.close();
  }
});
