import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const EVENT_SLUG = process.env.E2E_EVENT_SLUG ?? 'demo-concert';
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e2e@example.org';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';

/** Opens the demo event and waits until the seating chart has loaded. */
export async function openEvent(page: Page): Promise<void> {
  await page.goto(`/events/${EVENT_SLUG}`);
  await expect(page.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
}

/**
 * Ids of the seats that can be clicked right now, in plan order. Seats held in another cart or
 * sold carry no `data-seat` attribute.
 */
export async function clickableSeatIds(page: Page): Promise<string[]> {
  return page.$$eval('g[data-seat]', (els) => els.map((e) => e.getAttribute('data-seat') ?? ''));
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
