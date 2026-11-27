import { expect, test } from '@playwright/test';

/**
 * Events without a seating plan: an admission-only event without venue is created in the admin,
 * gets a price category and a contingent, is published and sold through the shop's ticket list
 * (no seating plan). The order shows admission tickets without row / seat and offers no seat
 * change. Runs in the admin project (signed in as the e2e SUPER_ADMIN; the purchase itself runs
 * in an anonymous browser context).
 */
const SLUG = 'e2e-fair';
const TITLE = 'E2E Fair';
const CONTINGENT = 'Day ticket';

test.describe.configure({ mode: 'serial' });

let eventId = '';
let orderNumber = '';

test('an admission-only event without venue is created, priced, given a contingent and published', async ({
  page,
}) => {
  await page.goto('/admin/events/new');
  await page.locator('#title').fill(TITLE);
  await page.locator('#slug').fill(SLUG);
  await page.locator('#seatingMode').selectOption('ADMISSION');
  await page.locator('#venueId').selectOption('');
  // No master plan for admission-only events.
  await expect(page.locator('#templateId')).toHaveCount(0);
  const year = new Date().getFullYear() + 1;
  await page.locator('#startsAt').fill(`${year}-06-14T18:00`);
  await page.getByRole('button', { name: 'Create event' }).click();
  await page.waitForURL(/\/admin\/events\/[0-9a-f-]{36}(\?|$)/, { timeout: 30_000 });
  eventId = /\/admin\/events\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  expect(eventId).toBeTruthy();

  // A price category (offered with the default tariff automatically).
  await page.goto(`/admin/events/${eventId}/pricing`);
  await page.getByRole('button', { name: 'New category' }).click();
  const categoryDialog = page.getByRole('dialog');
  await categoryDialog.locator('#cat-name').fill('Admission');
  await categoryDialog.locator('#cat-price').fill('12');
  await categoryDialog.getByRole('button', { name: 'Save' }).click();
  await expect(categoryDialog).toBeHidden();
  // Seat-only options are hidden for admission-only events.
  await page.getByRole('button', { name: 'New category' }).click();
  await expect(page.getByRole('dialog').getByText('Offer best-available booking')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A contingent.
  await page.goto(`/admin/events/${eventId}/seating`);
  await expect(async () => {
    if (!(await page.getByRole('dialog').isVisible()))
      await page.getByRole('button', { name: 'Add contingent' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const contingentDialog = page.getByRole('dialog');
  await contingentDialog.getByLabel('Name').fill(CONTINGENT);
  await contingentDialog.getByLabel('Capacity').fill('50');
  await contingentDialog.getByRole('button', { name: 'Add contingent' }).click();
  await expect(contingentDialog).toBeHidden();
  await expect(page.getByTestId('contingent-row')).toContainText(CONTINGENT);

  // Publish.
  await page.goto(`/admin/events/${eventId}`);
  await page.locator('#status').selectOption('PUBLISHED');
  await page.getByRole('button', { name: 'Apply status' }).click();
  await expect(async () => {
    await page.goto(`/admin/events/${eventId}`);
    await expect(page.locator('#status')).toHaveValue('PUBLISHED', { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
});

test('the shop sells two admission tickets from the ticket list (no seating plan)', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto(`/events/${SLUG}`);
    const list = page.getByTestId('admission-ticket-list');
    await expect(list).toBeVisible({ timeout: 30_000 });
    // No plan, no view toggle, no best-available.
    await expect(page.locator('svg g[data-seat]')).toHaveCount(0);
    await expect(page.getByTestId('seat-view-toggle')).toHaveCount(0);
    await expect(page.getByText('Best available', { exact: false })).toHaveCount(0);
    // No venue: no address / maps link in the header.
    await expect(page.getByRole('link', { name: /Show on Google Maps/i })).toHaveCount(0);

    const row = list.getByTestId('admission-row').filter({ hasText: CONTINGENT });
    await expect(row).toContainText('€12.00');
    const more = page.getByRole('button', { name: `One ticket more: ${CONTINGENT}` });
    await more.click();
    await expect(row.getByTestId('admission-quantity')).toHaveText('1');
    await more.click();
    await expect(row.getByTestId('admission-quantity')).toHaveText('2');
    // Keyboard: one less and one more again.
    await page.getByRole('button', { name: `One ticket less: ${CONTINGENT}` }).focus();
    await page.keyboard.press('Enter');
    await expect(row.getByTestId('admission-quantity')).toHaveText('1');
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(row.getByTestId('admission-quantity')).toHaveText('2');
    await expect(page.getByTestId('selection-subtotal')).toHaveText('€24.00');

    await page
      .getByRole('button', { name: /Continue to cart/i })
      .first()
      .click();
    await page.waitForURL(/\/cart/);
    await expect(page.locator('main').getByText(`${CONTINGENT} · Admission`)).toHaveCount(2);

    await page.getByRole('link', { name: /Proceed to checkout/i }).click();
    await page.waitForURL(/\/checkout/);
    await page.locator('#co-first').fill('Fay');
    await page.locator('#co-last').fill('E2E');
    await page.locator('#co-email').fill('fay.e2e@example.org');
    await page.locator('#co-phone').fill('+49 123 4567890');
    await page.locator('#co-street').fill('Teststrasse 2');
    await page.locator('#co-zip').fill('12345');
    await page.locator('#co-city').fill('Testhausen');
    await page.getByRole('radio', { name: /Bank transfer/i }).check({ force: true });
    await page.locator('button[role=checkbox]').last().click({ force: true });
    await page.getByRole('button', { name: /Place binding order/i }).click();

    await page.waitForURL(/\/orders\//, { timeout: 30_000 });
    orderNumber = /\/orders\/([^/?]+)/.exec(page.url())?.[1] ?? '';
    expect(orderNumber).toBeTruthy();
    const main = page.locator('main');
    await expect(main.getByText(`${CONTINGENT} · Admission`)).toHaveCount(2);
    await expect(main.getByText(/Row .* · Seat /)).toHaveCount(0);
    // No venue: no directions button.
    await expect(page.getByRole('link', { name: /Directions/i })).toHaveCount(0);
    await expect(main.getByText('Save the date in your calendar.', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the admin order has admission tickets and no seat change', async ({ page }) => {
  expect(orderNumber).toBeTruthy();
  await page.goto(`/admin/orders?q=${encodeURIComponent(orderNumber)}`);
  await page.locator('a[href^="/admin/orders/"]', { hasText: orderNumber }).first().click();
  await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}/);
  await expect(page.locator('main').getByText(`${CONTINGENT} · Admission`).first()).toBeVisible();
  await expect(async () => {
    if (!(await page.getByRole('menu').isVisible()))
      await page.getByTestId('order-actions').click();
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole('menuitem', { name: 'Change seats' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('the box office sells two admission tickets for cash from the contingent list', async ({
  page,
}) => {
  await page.goto('/admin/box-office');
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: new RegExp(TITLE) }).click();
  // Admission-only: the contingent list replaces the seating plan.
  const more = page.getByRole('button', { name: new RegExp(`^More: ${CONTINGENT} · `) }).first();
  await expect(more).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('svg g[data-seat]')).toHaveCount(0);
  await more.click();
  await expect(page.getByRole('button', { name: /Sell 1 ticket/ })).toBeEnabled({
    timeout: 20_000,
  });
  await more.click();
  const sell = page.getByRole('button', { name: /Sell 2 tickets · Cash/ });
  await expect(sell).toBeEnabled({ timeout: 20_000 });
  await sell.click();

  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Total .* · 2 tickets$/)).toBeVisible();
  await page.getByRole('link', { name: 'Open order' }).click();
  await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}/);
  const main = page.locator('main');
  // Two sold items and two issued, valid tickets - all admission, no row / seat.
  await expect(
    main.getByRole('cell', { name: `${CONTINGENT} · Admission`, exact: true }),
  ).toHaveCount(4);
  await expect(main.getByRole('cell', { name: 'Sold', exact: true })).toHaveCount(2);
  await expect(main.getByRole('cell', { name: 'Valid', exact: true })).toHaveCount(2);
  await expect(main.getByText(/Row .* · Seat /)).toHaveCount(0);
  await expect(main.getByText('Cash').first()).toBeVisible();
});
