import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

export const EVENT_SLUG = process.env.E2E_EVENT_SLUG ?? 'demo-concert';
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e2e@example.org';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

/** Opens the demo event and waits until the seating chart has loaded. */
export async function openEvent(page: Page): Promise<void> {
  await page.goto(`/events/${EVENT_SLUG}`);
  await expect(page.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
}

/**
 * Waits until the page's realtime socket is in the seat room (the gateway acknowledged the
 * subscription), so seat changes of another visitor are guaranteed to arrive as deltas.
 */
export async function waitRealtimeConnected(page: Page): Promise<void> {
  await expect(page.locator('[data-realtime="connected"]')).toBeAttached({ timeout: 30_000 });
}

/**
 * Ids of the seats that can be clicked right now, in plan order. Seats held in another cart or
 * sold carry no `data-seat` attribute.
 */
export async function clickableSeatIds(page: Page): Promise<string[]> {
  return page.$$eval('g[data-seat]', (els) => els.map((e) => e.getAttribute('data-seat') ?? ''));
}

/**
 * On an admin event page: opens the header's "Actions" menu and its "Duplicate" dialog (retried
 * until hydration has attached the menu's handlers).
 */
export async function openEventDuplicateDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(async () => {
    // A previous attempt may have opened it already (its check just came too late).
    if (await dialog.isVisible()) return;
    const item = page.getByRole('menuitem', { name: 'Duplicate' });
    if (!(await item.isVisible())) await page.getByTestId('event-actions').click();
    await item.click({ timeout: 2_000 });
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * On an admin order page: opens the dialog of an order action and returns it. `name` is either a
 * header button ("Record payment", "Send tickets again") or an entry of the "Actions" menu
 * ("Internal note" is inline, not here). Retried until hydration has attached the handlers.
 */
export async function openOrderAction(page: Page, name: string): Promise<Locator> {
  const dialog = page.getByRole('dialog');
  await expect(async () => {
    // A previous attempt may have opened it already (its check just came too late).
    if (await dialog.isVisible()) return;
    const header = page.getByRole('button', { name, exact: true }).first();
    if (await header.isVisible()) {
      await header.click({ timeout: 2_000 });
    } else {
      const item = page.getByRole('menuitem', { name, exact: true });
      if (!(await item.isVisible())) await page.getByTestId('order-actions').click();
      await item.click({ timeout: 2_000 });
    }
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return dialog;
}

/** Clicks a seat the way a visitor does (the SVG seats are tiny, hence force). */
export async function clickSeat(page: Page, id: string): Promise<void> {
  await page.locator(`g[data-seat="${id}"]`).click({ force: true });
}

/**
 * Installs a collector for CSP violations and returns a function reading (and clearing) them.
 * Must be called before the first navigation of the page.
 */
export async function collectCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return async () =>
    page
      .evaluate(() => {
        const w = window as unknown as { __csp?: string[] };
        const list = w.__csp ?? [];
        w.__csp = [];
        return list;
      })
      .catch(() => []);
}

export const AUTH_FILE = path.resolve(__dirname, '.auth/admin.json');
