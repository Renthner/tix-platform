import { expect, test, type Page } from '@playwright/test';
import { clickableSeatIds, clickSeat, EVENT_SLUG } from './helpers';

/**
 * A super-admin test-buys on a DRAFT event: the draft is invisible (404) for everybody else, the
 * order is a flagged test order, publishing is blocked while test orders exist, and deleting the
 * order releases the seat. Runs in the admin project
 * (signed in as the e2e SUPER_ADMIN).
 */
const SLUG = 'e2e-draft-purchase';
const TITLE = 'E2E Draft Purchase';

test.describe.configure({ mode: 'serial' });

let orderNumber = '';

async function demoEventId(page: Page): Promise<string> {
  await page.goto('/admin/events');
  const link = page.locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' }).first();
  const href = await link.getAttribute('href');
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  expect(id, `event id of ${EVENT_SLUG}`).toBeTruthy();
  return id!;
}

test('a draft event is created and offers "Test in shop" to the super-admin', async ({ page }) => {
  const id = await demoEventId(page);
  await page.goto(`/admin/events/${id}`);
  await page.getByRole('button', { name: 'Duplicate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#dupTitle').fill(TITLE);
  await dialog.locator('#dupSlug').fill(SLUG);
  await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.waitForURL(/\/admin\/events\/[0-9a-f-]{36}\?duplicated/, { timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Test in shop' })).toBeVisible();
});

test('the draft is a 404 for anonymous visitors and absent from home and sitemap', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const response = await page.goto(`/events/${SLUG}`);
    expect(response?.status()).toBe(404);
    const german = await page.goto(`/de/events/${SLUG}`);
    expect(german?.status()).toBe(404);
    await page.goto('/');
    await expect(page.locator(`a[href*="/events/${SLUG}"]`)).toHaveCount(0);
    const sitemap = await page.request.get('/sitemap.xml');
    expect(await sitemap.text()).not.toContain(SLUG);
  } finally {
    await context.close();
  }
});

test('the super-admin buys a seat on the draft: test order with banner and TEST badge', async ({
  page,
}) => {
  await page.goto(`/events/${SLUG}`);
  await expect(page.getByTestId('draft-banner').first()).toContainText(
    'Draft – visible to super admins only. Orders are test orders.',
  );
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
  const ids = await clickableSeatIds(page);
  await clickSeat(page, ids[10]!);
  await expect(page.getByRole('button', { name: /Continue to cart/i })).toBeEnabled();
  await page.getByRole('button', { name: /Continue to cart/i }).click();
  await page.waitForURL(/\/cart/);
  await expect(page.getByTestId('draft-banner')).toBeVisible();

  await page.getByRole('link', { name: /Proceed to checkout/i }).click();
  await page.waitForURL(/\/checkout/);
  await expect(page.getByTestId('draft-banner')).toBeVisible();
  await page.locator('#co-first').fill('Eva');
  await page.locator('#co-last').fill('Tester');
  await page.locator('#co-email').fill('eva.test@example.org');
  await page.locator('#co-phone').fill('+49 123 4567890');
  await page.locator('#co-street').fill('Teststrasse 1');
  await page.locator('#co-zip').fill('12345');
  await page.locator('#co-city').fill('Testhausen');
  await page.getByRole('radio', { name: /Bank transfer/i }).check({ force: true });
  await page.locator('button[role=checkbox]').last().click({ force: true });
  await page.getByRole('button', { name: /Place binding order/i }).click();

  await page.waitForURL(/\/orders\/TEST-/, { timeout: 30_000 });
  orderNumber = /\/orders\/(TEST-[^/?]+)/.exec(page.url())?.[1] ?? '';
  expect(orderNumber).toMatch(/^TEST-\d{4}-\d{4}$/);
  await expect(page.getByText('TEST', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('DE89 3704 0044 0532 0130 00').first()).toBeVisible();
});

test('a draft with test orders cannot be published: the dialog offers delete & publish or cancel only', async ({
  page,
}) => {
  await page.goto('/admin/events');
  const href = await page
    .locator('a[href^="/admin/events/"]', { hasText: TITLE })
    .first()
    .getAttribute('href');
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  expect(id, 'event id of the draft').toBeTruthy();
  await page.goto(`/admin/events/${id}`);
  await page.locator('#status').selectOption('PUBLISHED');
  await page.getByRole('button', { name: 'Apply status' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('A draft with test orders cannot be published');
  await expect(dialog.getByRole('button', { name: 'Publish anyway' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Delete test orders & publish' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  // Nothing happened: the event is still a draft.
  await page.goto(`/admin/events/${id}`);
  await expect(page.locator('#status')).toHaveValue('DRAFT');
});

test('the order shows a TEST badge in the admin list and can be deleted', async ({ page }) => {
  expect(orderNumber).not.toBe('');
  await page.goto('/admin/orders?tests=only');
  const row = page.locator('table tbody tr', { hasText: orderNumber });
  await expect(row).toBeVisible();
  await expect(row.getByText('TEST', { exact: true })).toBeVisible();
  await row.getByRole('link', { name: orderNumber }).click();
  await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}/);
  await page.getByRole('button', { name: 'Delete test order' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete test order', exact: true })
    .click();
  await page.waitForURL(/\/admin\/orders(\?.*)?$/, { timeout: 30_000 });
  await page.goto('/admin/orders?tests=only');
  await expect(page.locator('table tbody tr', { hasText: orderNumber })).toHaveCount(0);
});
