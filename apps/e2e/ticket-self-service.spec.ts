import { expect, test, type Page } from '@playwright/test';
import { clickableSeatIds, clickSeat, openEventDuplicateDialog, openOrderAction } from './helpers';

/**
 * Customer self-service for tickets: the buyer changes the attendee name (PDF link keeps working)
 * and hands a ticket over to someone else (recipient page shows the ticket, the buyer's list marks it
 * as passed on). Uses a super-admin test purchase on a DRAFT duplicate, so nothing real is created.
 * Runs in the admin project (signed in as the e2e SUPER_ADMIN).
 */
const SLUG = 'e2e-self-service';
const TITLE = 'E2E Self Service';

test.describe.configure({ mode: 'serial' });

let orderUrl = '';
let adminOrderUrl = '';
let ticketPath = '';

test('self-service is switched on globally (deadline 0)', async ({ page }) => {
  await page.goto('/admin/settings/selfService');
  const section = page.locator('#ticketSelfService');
  await expect(section).toBeVisible();
  const toggle = section.getByRole('switch').first();
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await section.locator('input[name="deadlineHoursBeforeStart"]').fill('0');
  const saved = page.waitForResponse((r) => r.request().method() === 'POST');
  await section.getByRole('button', { name: 'Save' }).click();
  await saved;
  await expect(section.locator('input[name="deadlineHoursBeforeStart"]')).toHaveValue('0');
  await page.reload();
  await expect(page.locator('#ticketSelfService').getByRole('switch').first()).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('a paid test order exists on a draft duplicate', async ({ page }) => {
  await page.goto('/admin/events');
  const href = await page
    .locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' })
    .first()
    .getAttribute('href');
  await page.goto(href!);
  await openEventDuplicateDialog(page);
  const dialog = page.getByRole('dialog');
  await dialog.locator('#dupTitle').fill(TITLE);
  await dialog.locator('#dupSlug').fill(SLUG);
  await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.waitForURL(/\/admin\/events\/[0-9a-f-]{36}\?duplicated/, { timeout: 30_000 });

  // Other specs of this session may have left seats of a published event in the cart.
  await page.goto('/cart');
  await expect(
    page.getByText('Your cart is empty.').or(page.getByRole('button', { name: /Remove/ }).first()),
  ).toBeVisible({ timeout: 15_000 });
  for (let n = 0; n < 20; n += 1) {
    const remove = page.getByRole('button', { name: /Remove/ }).first();
    if (!(await remove.isVisible().catch(() => false))) break;
    await remove.click();
    await page.waitForTimeout(600);
  }
  await expect(page.getByText('Your cart is empty.')).toBeVisible({ timeout: 15_000 });
  await page.goto(`/events/${SLUG}`);
  await expect(page.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
  const ids = await clickableSeatIds(page);
  await clickSeat(page, ids[20]!);
  await page.getByRole('button', { name: /Continue to cart/i }).click();
  await page.waitForURL(/\/cart/);
  await page.getByRole('link', { name: /Proceed to checkout/i }).click();
  await page.waitForURL(/\/checkout/);
  await page.locator('#co-first').fill('Sam');
  await page.locator('#co-last').fill('Buyer');
  await page.locator('#co-email').fill('sam.buyer@example.org');
  await page.locator('#co-phone').fill('+49 123 4567890');
  await page.locator('#co-street').fill('Teststrasse 1');
  await page.locator('#co-zip').fill('12345');
  await page.locator('#co-city').fill('Testhausen');
  await page.getByRole('radio', { name: /Bank transfer/i }).check({ force: true });
  await page.locator('button[role=checkbox]').last().click({ force: true });
  await page.getByRole('button', { name: /Place binding order/i }).click();
  await page.waitForURL(/\/orders\/TEST-/, { timeout: 30_000 });
  orderUrl = page.url();
  const number = /\/orders\/(TEST-[^/?]+)/.exec(orderUrl)![1]!;

  await page.goto('/admin/orders?tests=only');
  await page
    .locator('table tbody tr', { hasText: number })
    .getByRole('link', { name: number })
    .click();
  await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}/);
  adminOrderUrl = page.url();
  const payment = await openOrderAction(page, 'Record payment');
  await payment.getByRole('button', { name: 'Record payment' }).click();
  await expect(payment).toBeHidden({ timeout: 30_000 });
  // Tickets are issued by the worker: reload until they show up.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Issued tickets')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
});

async function openOrder(page: Page) {
  await page.goto(orderUrl);
  await expect(page.locator('[data-slot="ticket-self-service"]').first()).toBeVisible({
    timeout: 30_000,
  });
}

test('the buyer changes the attendee name, the PDF link keeps working', async ({ page }) => {
  await openOrder(page);
  await page.locator('[data-slot="ticket-change-name"]').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name on the ticket').fill('Pat Newname');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Pat Newname').first()).toBeVisible({ timeout: 15_000 });
  const href = await page
    .locator('[data-slot="ticket-downloads"] a[href*="/api/orders/"]')
    .first()
    .getAttribute('href');
  ticketPath = href!.split('?')[0]!;
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
});

test('anonymous visitors and bad tokens cannot change or pass on a ticket', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    for (const action of ['name', 'transfer']) {
      for (const query of ['', '?t=garbage']) {
        const body =
          action === 'name'
            ? { name: 'Mallory' }
            : { recipientName: 'Mallory', recipientEmail: 'mallory@example.org' };
        const res = await context.request.post(`${ticketPath}/${action}`, {
          data: query ? { ...body, t: 'garbage' } : body,
          headers: { origin: baseURL! },
        });
        expect(res.status(), `${action} ${query || 'no token'}`).toBe(404);
      }
    }
  } finally {
    await context.close();
  }
});

test('the buyer passes the ticket on: recipient page works, old ticket is marked as passed on', async ({
  page,
  browser,
}) => {
  await openOrder(page);
  await page.locator('[data-slot="ticket-transfer"]').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name of the recipient').fill('Robin Recipient');
  await dialog
    .getByLabel('E-mail of the recipient', { exact: true })
    .fill('robin.recipient@example.org');
  await dialog
    .getByLabel('Repeat the e-mail of the recipient', { exact: true })
    .fill('robin.recipient@example.org');
  await dialog.getByRole('button', { name: 'Pass on ticket' }).click();
  await expect(page.locator('[data-slot="ticket-transferred"]').first()).toContainText(
    'robin.recipient@example.org',
    { timeout: 15_000 },
  );

  // The buyer cannot touch the handed-over ticket any more: no rename, no second transfer.
  await page.goto(orderUrl);
  await expect(page.locator('[data-slot="ticket-transferred"]').first()).toBeVisible();
  await expect(page.locator('[data-slot="ticket-transfer"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="ticket-change-name"]')).toHaveCount(0);

  // The admin order page shows the recipient's ticket page; open it as an anonymous visitor.
  await page.goto(adminOrderUrl);
  await expect(page.getByTestId('ticket-changes')).toContainText('Robin Recipient');
  const link = await page.locator('[data-slot="holder-ticket-link"]').first().getAttribute('href');
  expect(link).toContain('/tickets/');
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const anon = await context.newPage();
    const response = await anon.goto(link!);
    expect(response?.status()).toBe(200);
    await expect(anon.locator('[data-slot="holder-ticket"]')).toContainText('Robin Recipient');
    const pdf = await anon.locator('[data-slot="holder-pdf"]').getAttribute('href');
    const res = await anon.request.get(pdf!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/pdf');
    // Without the token the page is a 404.
    const bad = await anon.goto(link!.split('?')[0]!);
    expect(bad?.status()).toBe(404);

    // The holder (not the buyer) may pass the ticket on, but not rename it.
    await anon.goto(link!);
    await expect(anon.locator('[data-slot="ticket-change-name"]')).toHaveCount(0);
    await anon.locator('[data-slot="ticket-transfer"]').click();
    const holderDialog = anon.getByRole('dialog');
    await holderDialog.getByLabel('Name of the recipient').fill('Nina Next');
    await holderDialog
      .getByLabel('E-mail of the recipient', { exact: true })
      .fill('nina.next@example.org');
    await holderDialog
      .getByLabel('Repeat the e-mail of the recipient', { exact: true })
      .fill('nina.next@example.org');
    await holderDialog.getByRole('button', { name: 'Pass on ticket' }).click();
    await expect(anon.locator('[data-slot="holder-ticket-void"]')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await context.close();
  }
});
