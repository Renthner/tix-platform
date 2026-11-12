import { expect, test } from '@playwright/test';
import { collectCsp, EVENT_SLUG } from './helpers';

// Every page must load without CSP violations and uncaught exceptions.
const SHOP_PAGES = ['/', `/events/${EVENT_SLUG}`, '/cart', '/de', `/de/events/${EVENT_SLUG}`];
const ADMIN_PAGES = [
  '/admin',
  '/admin/events',
  '/admin/orders',
  '/admin/venues',
  '/admin/ticket-templates',
  '/admin/email-templates',
  '/admin/banking',
  '/admin/settings',
  '/admin/scanners',
  '/admin/waiting-room',
  '/admin/box-office',
  '/de/admin',
];

for (const path of [...SHOP_PAGES, ...ADMIN_PAGES]) {
  test(`no CSP violation or page error on ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    const violations = await collectCsp(page);
    const res = await page.goto(path);
    expect(res?.status(), `status of ${path}`).toBeLessThan(400);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(500);
    expect([...errors, ...(await violations())]).toEqual([]);
  });
}
