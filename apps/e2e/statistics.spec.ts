import { expect, request as playwrightRequest, test } from '@playwright/test';
import { collectCsp } from './helpers';

// Runs with the stored admin session (see auth.setup.ts). The e2e shop has no paid order, so the
// figures are zero: the page and charts must still render without CSP violations or page errors.

test('statistics page renders KPIs and charts without CSP violations', async ({ page }) => {
  const csp = await collectCsp(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin/statistics?range=year');
  await expect(page.getByRole('heading', { name: 'Statistics' })).toBeVisible();
  await expect(page.getByText('Revenue (gross)').first()).toBeVisible();
  await expect(page.getByText('Tickets sold').first()).toBeVisible();
  // Line charts are SVGs with an accessible summary.
  const chart = page.locator('svg[role="img"][aria-label^="Line chart of gross revenue"]');
  await expect(chart).toBeVisible();
  await expect(page.getByRole('table', { name: /Heat map of orders/ })).toBeVisible();

  // The data table behind the toggle shows the same series as text.
  await page.getByRole('button', { name: 'Show data table' }).first().click();
  await expect(page.locator('table').first()).toBeVisible();

  expect(await csp()).toEqual([]);
  expect(errors).toEqual([]);
});

test('statistics filters live in the URL', async ({ page }) => {
  await page.goto('/admin/statistics');
  await page.getByRole('button', { name: '7 days' }).click();
  await expect(page).toHaveURL(/range=7d/);
  // The date fields follow the new range (the form must not keep its old state).
  const from = page.getByLabel('From', { exact: true });
  await expect(from).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  const sevenDays = await from.inputValue();
  await page.getByRole('button', { name: '30 days' }).click();
  await expect(page).toHaveURL(/range=30d/);
  await expect(from).not.toHaveValue(sevenDays);
  await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page).toHaveURL(/range=today/);
  await expect(page.locator('svg[role="img"]').first()).toBeVisible();
});

test('statistics page has no horizontal scroll on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/admin/statistics?range=30d');
  await expect(page.getByText('Revenue (gross)').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('CSV export returns the time series', async ({ page }) => {
  const response = await page.request.get('/api/admin/statistics/export?range=7d&locale=en');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/csv');
  const body = await response.text();
  expect(body).toContain('Period start');
  expect(body.trim().split('\r\n')).toHaveLength(8); // header + 7 days
});

test('system page shows the queue table and live values', async ({ page }) => {
  const csp = await collectCsp(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin/system');
  await expect(page.getByRole('heading', { name: 'System' })).toBeVisible();
  const rows = page.getByTestId('queue-table').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  await expect(page.getByText(/Updated /)).toBeVisible();

  const stats = await page.request.get('/api/admin/system/stats');
  expect(stats.status()).toBe(200);
  const json = await stats.json();
  expect(json.app.version).toBeTruthy();
  expect(Array.isArray(json.queues)).toBe(true);

  expect(await csp()).toEqual([]);
  expect(errors).toEqual([]);
});

test('metrics endpoint does not exist without a token', async ({ request }) => {
  const response = await request.get('/api/metrics');
  expect(response.status()).toBe(404);
});

test('statistics and system endpoints reject unauthenticated requests', async ({ baseURL }) => {
  const anonymous = await playwrightRequest.newContext({ baseURL, storageState: undefined });
  try {
    for (const path of ['/api/admin/system/stats', '/api/admin/statistics/export']) {
      const response = await anonymous.get(path);
      expect(response.status(), path).toBe(403);
    }
    const metrics = await anonymous.get('/api/metrics', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(metrics.status()).toBe(404); // disabled: the endpoint does not reveal itself
  } finally {
    await anonymous.dispose();
  }
});
