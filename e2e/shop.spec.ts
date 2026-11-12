import { expect, test, type Page } from '@playwright/test';
import { clickableSeatIds, clickSeat, EVENT_SLUG, openEvent } from './helpers';

// Seat ranges per test, so that held seats of one test never disturb another.
const MANUAL = [40, 41];
const REALTIME = [200, 201];
const ORDER = [300, 301];

test('home lists the demo event', async ({ page }) => {
  await page.goto('/');
  const link = page.locator(`a[href*="/events/${EVENT_SLUG}"]`).first();
  await expect(link).toBeVisible();
  await expect(page.getByText('Demo Concert').first()).toBeVisible();
});

test('event page renders the seating chart', async ({ page }) => {
  await openEvent(page);
  await expect(page.getByRole('heading', { name: 'Demo Concert' }).first()).toBeVisible();
  expect((await clickableSeatIds(page)).length).toBeGreaterThan(100);
});

test('manual seat clicks select seats', async ({ page }) => {
  await openEvent(page);
  const ids = await clickableSeatIds(page);
  for (const [n, i] of MANUAL.entries()) {
    await clickSeat(page, ids[i]!);
    // The selection list ("Stalls · Row C · Seat 4") grows with every click.
    await expect(page.getByRole('listitem').filter({ hasText: /Row \S+ · Seat \S+/ })).toHaveCount(
      n + 1,
    );
  }
  await expect(page.getByText('Your selection', { exact: true })).toBeVisible();
  await expect(page.getByText(/^2 \/ \d+$|^2 selected$/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue to cart/i })).toBeEnabled();
});

test('a held seat shows up as "in another cart" in a second browser within 10 s', async ({
  browser,
}) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const pa = await a.newPage();
    const pb = await b.newPage();
    await openEvent(pa);
    await openEvent(pb);
    const ids = await clickableSeatIds(pb);
    const held = REALTIME.map((i) => ids[i]!);
    for (const id of held) await clickSeat(pa, id);
    for (const id of held) {
      // Taken seats lose their click target (`data-seat`) in the other browser.
      await expect(pb.locator(`g[data-seat="${id}"]`)).toHaveCount(0, { timeout: 10_000 });
      await expect(pa.locator(`g[data-seat="${id}"]`)).toHaveCount(1);
    }
  } finally {
    await a.close();
    await b.close();
  }
});

async function selectSeats(page: Page, range: number[]) {
  await openEvent(page);
  const ids = await clickableSeatIds(page);
  for (const i of range) {
    await clickSeat(page, ids[i]!);
    await page.waitForTimeout(400);
  }
}

test('cart: reservation timer and tariff change; checkout by bank transfer creates an order', async ({
  page,
}) => {
  await selectSeats(page, ORDER);
  await page.getByRole('button', { name: /Continue to cart/i }).click();
  await page.waitForURL(/\/cart/);

  // The reservation countdown (m:ss) is visible in the header.
  await expect(
    page
      .locator('header')
      .getByText(/\d{1,2}:\d{2}/)
      .first(),
  ).toBeVisible();

  // Switch the tariff of the first seat.
  const tariff = page.locator('main [role=combobox]').first();
  const before = (await page.locator('main').innerText()).match(/€\s?[\d.,]+|[\d.,]+\s?€/g);
  await tariff.click();
  const options = page.getByRole('option');
  await expect(options.nth(1)).toBeVisible();
  await options.nth(1).click();
  await expect
    .poll(async () => (await page.locator('main').innerText()).match(/€\s?[\d.,]+|[\d.,]+\s?€/g))
    .not.toEqual(before);

  await page.getByRole('link', { name: /Proceed to checkout/i }).click();
  await page.waitForURL(/\/checkout/);

  await page.locator('#co-first').fill('Eva');
  await page.locator('#co-last').fill('E2E');
  await page.locator('#co-email').fill('eva.e2e@example.org');
  await page.locator('#co-phone').fill('+49 123 4567890');
  await page.locator('#co-street').fill('Teststrasse 1');
  await page.locator('#co-zip').fill('12345');
  await page.locator('#co-city').fill('Testhausen');
  await page.getByRole('radio', { name: /Bank transfer/i }).check({ force: true });
  await page.locator('button[role=checkbox]').last().click({ force: true });
  await page.getByRole('button', { name: /Place binding order/i }).click();

  await page.waitForURL(/\/orders\//, { timeout: 30_000 });
  await expect(page.getByText(/TIX-\d{4}-\d+-\d/).first()).toBeVisible();
  await expect(page.getByText('DE89 3704 0044 0532 0130 00').first()).toBeVisible();
});
