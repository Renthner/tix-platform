import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  AUTH_FILE,
  clickableSeatIds,
  clickSeat,
  collectCsp,
  EVENT_SLUG,
  openEvent,
} from './helpers';

// Colour theme: switch, persistence, OS default and WCAG AA colour contrast in both themes.
// The file is matched by the `shop` (anonymous) and `admin` (signed in) projects; every test only
// runs in the project it belongs to.

type Theme = 'light' | 'dark';
const THEMES: Theme[] = ['light', 'dark'];

/**
 * Regions that are intentionally not themed (documented allow-list): the e-mail preview (an
 * iframe and the visual editor, both showing the real e-mail on white) and the admin-authored
 * start page HTML (rendered on a light sheet). Canvases (seating plan editor, ticket designer paper) are not inspected by axe.
 */
const AXE_EXCLUDE = ['iframe', '.tix-start-custom', '.tix-email-surface'];

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.context().addCookies([
    {
      name: 'tix_theme',
      value: theme,
      url: process.env.E2E_BASE_URL ?? 'http://localhost:18090',
    },
  ]);
}

async function contrastViolations(page: Page): Promise<string[]> {
  // One `exclude` call per selector: an array would be read as a path through nested iframes.
  const builder = new AxeBuilder({ page }).withRules(['color-contrast']);
  for (const selector of AXE_EXCLUDE) builder.exclude(selector);
  const result = await builder.analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) =>
      v.nodes.map(
        (n) => `${v.id}: ${n.target.join(' ')} - ${(n.any[0]?.message ?? '').replace(/\s+/g, ' ')}`,
      ),
    );
}

async function settle(page: Page): Promise<void> {
  // Not `networkidle`: the live pages keep polling / holding sockets, which never goes idle.
  await page.waitForLoadState('load');
  await page.waitForTimeout(1200);
}

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));

test.describe('theme switch (shop)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'shop', 'shop project only');
  });

  test('follows the OS colour scheme by default', async ({ browser }) => {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto('/');
      expect(await isDark(page), `OS ${scheme}`).toBe(scheme === 'dark');
      await ctx.close();
    }
  });

  test('switch changes the theme, persists in a cookie and survives a reload', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    const csp = await collectCsp(page);
    await page.goto('/');
    const toggle = page.getByTestId('theme-switcher');
    await expect(toggle).toHaveAttribute('aria-label', /Colour theme: System/);

    // Keyboard operable.
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    expect(await isDark(page)).toBe(true);
    await expect(toggle).toHaveAttribute('aria-label', /Colour theme: Dark/);
    const cookie = (await ctx.cookies()).find((c) => c.name === 'tix_theme');
    expect(cookie?.value).toBe('dark');

    // The server renders the class (no flash): check the raw HTML of a fresh request.
    const html = await (await ctx.request.get('/')).text();
    expect(html).toMatch(/<html[^>]*class="dark"/);

    await page.reload();
    expect(await isDark(page)).toBe(true);

    await page.getByTestId('theme-switcher').click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    expect(await isDark(page)).toBe(false);
    await page.reload();
    expect(await isDark(page)).toBe(false);

    // Back to System: cookie removed, the OS decides again.
    await page.getByTestId('theme-switcher').click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    expect((await ctx.cookies()).find((c) => c.name === 'tix_theme')).toBeUndefined();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => isDark(page)).toBe(true);
    expect(await csp()).toEqual([]);
    await ctx.close();
  });

  test('German labels', async ({ page }) => {
    await page.goto('/de');
    await expect(page.getByTestId('theme-switcher')).toHaveAttribute(
      'aria-label',
      /Farbschema: System/,
    );
  });

  test('cookie page lists the theme cookie', async ({ page }) => {
    await page.goto('/cookies');
    await expect(page.getByText('tix_theme')).toBeVisible();
  });
});

test.describe('theme switch (admin)', () => {
  test.use({ storageState: AUTH_FILE });
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'admin project only');
  });

  test('switch is available in the admin sidebar and applies', async ({ page }) => {
    await page.goto('/admin');
    const toggle = page.getByTestId('theme-switcher').first();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    expect(await isDark(page)).toBe(true);
    await page.reload();
    expect(await isDark(page)).toBe(true);
    await page.getByTestId('theme-switcher').first().click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
  });
});

test.describe('theme switch (shop header, signed-in admin on a phone)', () => {
  test.use({ storageState: AUTH_FILE });
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'admin project only');
  });

  test('theme items live in the admin dropdown and the shop name stays visible', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    await expect(page.getByTestId('theme-switcher')).toBeHidden();
    const name = page.locator('header a[href="/"]').first();
    const box = await name.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(40);
    await page
      .getByRole('button', { name: /dashboard/i })
      .last()
      .click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect.poll(() => isDark(page)).toBe(true);
    await page
      .getByRole('button', { name: /dashboard/i })
      .last()
      .click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    // Wide screens keep the button in the header.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.getByTestId('theme-switcher')).toBeVisible();
  });
});

const SHOP_PAGES = [
  '/',
  `/events/${EVENT_SLUG}`,
  '/cart',
  '/checkout',
  '/account/login',
  '/cookies',
  '/de',
  '/no-such-page',
];

test.describe('colour contrast (shop)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'shop', 'shop project only');
  });
  for (const theme of THEMES) {
    test(`${theme}: no serious contrast violations`, async ({ page }) => {
      test.setTimeout(180_000);
      await setTheme(page, theme);
      const csp = await collectCsp(page);
      const found: string[] = [];
      const cspFound: string[] = [];
      const check = async (path: string) => {
        await settle(page);
        expect(await isDark(page), `${path} theme`).toBe(theme === 'dark');
        found.push(...(await contrastViolations(page)).map((v) => `${path} ${v}`));
        cspFound.push(...(await csp()).map((v) => `${path} ${v}`));
      };
      for (const path of SHOP_PAGES) {
        await page.goto(path);
        await check(path);
      }
      // Seats in the cart: event page with a selection, then the filled cart and checkout.
      await openEvent(page);
      const ids = await clickableSeatIds(page);
      for (const i of [60, 61]) {
        await clickSeat(page, ids[i]!);
        await page.waitForTimeout(400);
      }
      await check(`/events/${EVENT_SLUG} (selection)`);
      for (const path of ['/cart', '/checkout']) {
        await page.goto(path);
        await expect(page.locator('main')).toContainText(/€/);
        await check(`${path} (filled)`);
      }
      console.log(`[axe] shop ${theme}: ${found.length} violations`);
      expect(found).toEqual([]);
      expect(cspFound).toEqual([]);
    });
  }
});

test.describe('colour contrast (admin)', () => {
  test.use({ storageState: AUTH_FILE });
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'admin project only');
  });

  /** Sidebar entries, settings tabs, first event with its tabs and editors, discovered live. */
  async function adminPages(page: Page): Promise<string[]> {
    const hrefs = new Set<string>();
    const collect = async (selector: string) => {
      const found = await page.$$eval(selector, (els) =>
        els.map((e) => e.getAttribute('href') ?? ''),
      );
      for (const h of found) {
        if (/^\/(admin|orders)(\/|$)/.test(h) && !h.includes('logout')) hrefs.add(h);
      }
    };
    await page.goto('/admin');
    await collect('aside a[href^="/admin"]');
    await page.goto('/admin/settings/general');
    await collect('nav[aria-label] a[href^="/admin/settings"]');
    await page.goto('/admin/events');
    // The first real event (not "shop-order" and the like): its id is a UUID.
    const eventHref = await page
      .locator('a[href^="/admin/events/"]')
      .evaluateAll(
        (els) =>
          els
            .map((e) => e.getAttribute('href') ?? '')
            .find((h) => /^\/admin\/events\/[0-9a-f]{8}-[0-9a-f-]{27}$/.test(h)) ?? null,
      );
    if (eventHref) {
      hrefs.add(eventHref);
      await page.goto(eventHref);
      await collect('a[href^="/admin/events/"]');
      // Every event tab, also those that the tab bar only shows conditionally.
      for (const tab of [
        'seating',
        'pricing',
        'shop-page',
        'ticket',
        'check-in',
        'fees',
        'sales',
        'wallet',
        'access-codes',
        'waiting-room',
      ]) {
        hrefs.add(`${eventHref}/${tab}`);
      }
    }
    for (const list of ['/admin/ticket-templates', '/admin/email-templates']) {
      await page.goto(list);
      await collect(`main a[href^="${list}/"]`);
    }
    if (eventHref) {
      // The seating plan editor (a full-screen Konva canvas) is opened from the event.
      await page.goto(`${eventHref}/seating`);
      await collect('main a[href^="/admin/seat-maps/"]');
    }
    // An order: admin detail page and the customer view of it (the shop order page).
    await page.goto('/admin/orders');
    const orderHref = await page
      .locator('main a[href^="/admin/orders/"]')
      .first()
      .getAttribute('href');
    if (orderHref) {
      hrefs.add(orderHref);
      await page.goto(orderHref);
      const customerView = await page
        .getByRole('link', { name: /Customer view/i })
        .getAttribute('href');
      if (customerView) hrefs.add(customerView);
    }
    return [...hrefs];
  }

  for (const theme of THEMES) {
    test(`${theme}: no serious contrast violations`, async ({ page }) => {
      test.setTimeout(600_000);
      await setTheme(page, theme);
      const pages = await adminPages(page);
      expect(pages.length).toBeGreaterThan(15);
      const csp = await collectCsp(page);
      const found: string[] = [];
      const cspFound: string[] = [];
      for (const path of pages) {
        await page.goto(path);
        await settle(page);
        expect(await isDark(page), `${path} theme`).toBe(theme === 'dark');
        found.push(...(await contrastViolations(page)).map((v) => `${path} ${v}`));
        cspFound.push(...(await csp()).map((v) => `${path} ${v}`));
      }
      console.log(`[axe] admin ${theme}: ${found.length} violations over ${pages.length} pages`);
      expect(found).toEqual([]);
      expect(cspFound).toEqual([]);
    });

    test(`${theme}: admin login page has no serious contrast violations`, async ({ browser }) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await setTheme(page, theme);
      const csp = await collectCsp(page);
      await page.goto('/admin/login');
      await settle(page);
      expect(await isDark(page)).toBe(theme === 'dark');
      expect(await contrastViolations(page)).toEqual([]);
      expect(await csp()).toEqual([]);
      await ctx.close();
    });
  }
});
