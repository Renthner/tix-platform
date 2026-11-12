import { expect, test } from '@playwright/test';
import { collectCsp, EVENT_SLUG } from './helpers';

// Runs with the stored admin session (see auth.setup.ts).

test('dashboard shows the first-steps checklist', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('First steps').first()).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ steps done/)).toBeVisible();
});

test('orders list shows the shop order with its tickets', async ({ page }) => {
  await page.goto('/admin/orders');
  const row = page.locator('table tbody tr', { hasText: 'eva.e2e@example.org' }).first();
  await expect(row).toBeVisible();
  const headers = await page.locator('table thead th').allInnerTexts();
  const col = headers.findIndex((h) => h.trim() === 'Tickets');
  expect(col).toBeGreaterThanOrEqual(0);
  const tickets = Number((await row.locator('td').nth(col).innerText()).trim());
  expect(tickets).toBeGreaterThan(0);
  await expect(row).toContainText('Awaiting transfer');
});

async function eventId(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/admin/events');
  const link = page.locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' }).first();
  const href = await link.getAttribute('href');
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  expect(id, `event id of ${EVENT_SLUG}`).toBeTruthy();
  return id!;
}

test('seat plan editor renders its canvas', async ({ page }) => {
  const id = await eventId(page);
  await page.goto(`/admin/events/${id}/seating`);
  await page.getByRole('link', { name: 'Open seating editor' }).click();
  await page.waitForURL('**/admin/seat-maps/**');
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const size = await canvas.evaluate((c) => [
    (c as HTMLCanvasElement).width,
    (c as HTMLCanvasElement).height,
  ]);
  expect(size[0]).toBeGreaterThan(100);
  expect(size[1]).toBeGreaterThan(100);
});

test('ticket designer preview iframe receives a blob: src', async ({ page }) => {
  const id = await eventId(page);
  const violations = await collectCsp(page);
  await page.goto(`/admin/events/${id}/ticket`);
  await page.getByRole('link', { name: 'Edit design' }).first().click();
  await page.waitForURL('**/admin/ticket-templates/**');
  await expect(page.locator('iframe[src^="blob:"]')).toHaveCount(1, { timeout: 30_000 });
  expect(await violations()).toEqual([]);
});
