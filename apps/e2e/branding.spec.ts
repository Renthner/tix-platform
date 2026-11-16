import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { AUTH_FILE, EVENT_SLUG, clickableSeatIds, clickSeat, collectCsp } from './helpers';
import { gradientPng } from './png';

// Settings → Appearance: brand colour, shop theme mode, logo height, sponsors and the Cloudflare
// e-mail opt-out. Runs in the `admin` project (signed in); the shop is always looked at with an
// anonymous browser context. All of it is global state: restored in afterAll (also after failures).

const ANON = { cookies: [], origins: [] };
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:18090';
const SHOTS = process.env.E2E_SHOTS_DIR;

interface BrandingForm {
  themeMode?: string;
  defaultTheme?: string;
  brandColor?: string;
  brandColorDark?: string;
  logoHeight?: string;
}

const DEFAULTS: Required<BrandingForm> = {
  themeMode: 'VISITOR_CHOICE',
  defaultTheme: 'SYSTEM',
  brandColor: '#111827',
  brandColorDark: '',
  logoHeight: '36',
};

const brandingForm = (page: Page) =>
  page.locator('form').filter({ has: page.locator('#themeMode') });
const sponsorsForm = (page: Page) =>
  page.locator('form').filter({ has: page.getByTestId('sponsor-rows') });

async function saved(form: ReturnType<Page['locator']>) {
  // Success is announced with a toast: let an earlier one disappear first.
  const toast = form.page().getByText('Changes saved.');
  await expect(toast).toHaveCount(0, { timeout: 10_000 });
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toast.first()).toBeVisible();
}

async function saveBranding(page: Page, v: BrandingForm): Promise<void> {
  await page.goto('/admin/settings/appearance');
  const form = brandingForm(page);
  if (v.themeMode !== undefined) await form.locator('#themeMode').selectOption(v.themeMode);
  if (v.defaultTheme !== undefined)
    await form.locator('#defaultTheme').selectOption(v.defaultTheme);
  if (v.brandColor !== undefined) await form.locator('input[name="brandColor"]').fill(v.brandColor);
  if (v.brandColorDark !== undefined)
    await form.locator('input[name="brandColorDark"]').fill(v.brandColorDark);
  if (v.logoHeight !== undefined) await form.locator('#logoHeight').fill(v.logoHeight);
  await saved(form);
}

async function anonymous(
  browser: Browser,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ storageState: ANON, baseURL: BASE, ...options });
  return { ctx, page: await ctx.newPage() };
}

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));
const primary = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--primary').trim().toLowerCase(),
  );

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

async function contrastViolations(page: Page): Promise<string[]> {
  const builder = new AxeBuilder({ page }).withRules(['color-contrast']);
  for (const selector of ['iframe', '.tix-start-custom']) builder.exclude(selector);
  const result = await builder.analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

async function removeSponsorsAndLogo(page: Page): Promise<void> {
  await page.goto('/admin/settings/appearance');
  const sForm = sponsorsForm(page);
  const sw = sForm.getByRole('switch').first();
  if ((await sw.getAttribute('aria-checked')) === 'true') await sw.click();
  while ((await sForm.getByTestId('sponsor-row').count()) > 0) {
    await sForm.getByRole('button', { name: 'Remove sponsor' }).first().click();
  }
  await saved(sForm);
  const form = brandingForm(page);
  const logoPicker = form.locator('input[name="logoAssetId"]').locator('xpath=..');
  const remove = logoPicker.getByRole('button', { name: 'Remove', exact: true });
  if (await remove.count()) await remove.click();
  await form.locator('.ProseMirror').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await saved(form);
}

test.describe.serial('brand colour, theme mode, logo and sponsors', () => {
  test.use({ storageState: AUTH_FILE });
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'admin project only');
  });
  test.setTimeout(180_000);

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: AUTH_FILE, baseURL: BASE });
    const page = await ctx.newPage();
    try {
      await saveBranding(page, DEFAULTS);
      await removeSponsorsAndLogo(page);
    } finally {
      await ctx.close();
    }
  });

  test('settings page: live preview in both themes and contrast warning', async ({ page }) => {
    await page.goto('/admin/settings/appearance');
    const form = brandingForm(page);
    await expect(page.getByTestId('brand-preview-light')).toBeVisible();
    await expect(page.getByTestId('brand-preview-dark')).toBeVisible();
    await expect(page.getByTestId('brand-contrast-warning')).toHaveCount(0);
    await form.locator('input[name="brandColor"]').fill('#FACC15');
    await expect(page.getByTestId('brand-contrast-warning')).toBeVisible();
    await expect(page.getByTestId('brand-preview-light')).toContainText('1.5:1');
    // Dark override replaces the computed colour in the preview.
    await form.locator('input[name="brandColor"]').fill('#1E3A8A');
    await expect(page.getByTestId('brand-contrast-warning')).toHaveCount(0);
    await form.locator('input[name="brandColorDark"]').fill('#93C5FD');
    await expect(page.getByText('Your own colour is used in the dark theme.')).toBeVisible();
    await form.locator('#logoHeight').scrollIntoViewIfNeeded();
    if (SHOTS)
      await page.screenshot({ path: `${SHOTS}/settings-appearance-brand.png`, fullPage: false });
    // Invalid values are rejected with the input kept.
    await form.locator('input[name="brandColor"]').fill('#12');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form.locator('input[name="brandColor"]')).toHaveValue('#12');
    await expect(form.locator('#color-brandColor')).toHaveAttribute('aria-invalid', 'true');
    // Logo height accepts values beyond the slider range, but not beyond the maximum.
    await form.locator('input[name="brandColor"]').fill('#1E3A8A');
    await form.locator('#logoHeight').fill('250');
    // The browser itself refuses the value above the maximum (native range validation).
    expect(
      await form
        .locator('#logoHeight')
        .evaluate((el: HTMLInputElement) => el.validity.rangeOverflow),
    ).toBe(true);
    await form.locator('#logoHeight').fill('150');
    expect(
      await form.locator('#logoHeight').evaluate((el: HTMLInputElement) => el.validity.valid),
    ).toBe(true);
    await form.locator('#logoHeight').fill('36');
  });

  test('brand colour drives the shop (light + computed dark), not the admin; contrast stays AA', async ({
    browser,
    page,
  }) => {
    await saveBranding(page, { brandColor: '#1E3A8A', brandColorDark: '' });
    const { ctx, page: shop } = await anonymous(browser, { colorScheme: 'light' });
    const csp = await collectCsp(shop);
    await expect
      .poll(async () => {
        await shop.goto('/');
        return primary(shop);
      })
      .toBe('#1e3a8a');
    const darkCookie = { name: 'tix_theme', value: 'dark', url: BASE };
    await ctx.addCookies([darkCookie]);
    await shop.goto('/');
    expect(await isDark(shop)).toBe(true);
    const darkPrimary = await primary(shop);
    expect(darkPrimary).toMatch(/^#[0-9a-f]{6}$/);
    expect(darkPrimary).not.toBe('#1e3a8a');
    expect(luminance(darkPrimary)).toBeGreaterThan(luminance('#1e3a8a'));

    // Browser chrome colour: light = brand, dark = the dark page background (media specific).
    const metas = await shop
      .locator('meta[name="theme-color"]')
      .evaluateAll((els) => els.map((e) => [e.getAttribute('media'), e.getAttribute('content')]));
    expect(metas).toEqual(
      expect.arrayContaining([
        ['(prefers-color-scheme: light)', expect.stringMatching(/1e3a8a/i)],
        ['(prefers-color-scheme: dark)', expect.stringMatching(/^#0a0a0a$/i)],
      ]),
    );
    const manifest = await (await shop.request.get('/manifest.webmanifest')).json();
    expect(String(manifest.theme_color).toLowerCase()).toBe('#1e3a8a');

    // AA contrast in both themes with the brand colour applied.
    for (const theme of ['light', 'dark'] as const) {
      await ctx.addCookies([{ ...darkCookie, value: theme }]);
      for (const path of ['/', `/events/${EVENT_SLUG}`, '/cart']) {
        await shop.goto(path);
        await shop.waitForLoadState('load');
        await shop.waitForTimeout(800);
        expect(await isDark(shop), `${path} ${theme}`).toBe(theme === 'dark');
        expect(await contrastViolations(shop), `${path} ${theme}`).toEqual([]);
      }
    }
    expect(await csp()).toEqual([]);
    await ctx.close();

    // The admin portal keeps its neutral palette.
    await page.goto('/admin');
    expect(await primary(page)).not.toMatch(/^#/); // neutral token, not the brand hex
  });

  test('theme mode: fixed dark / light ignores the cookie and hides the switch; admin unaffected', async ({
    browser,
    page,
  }) => {
    await saveBranding(page, { themeMode: 'ALWAYS_DARK' });
    const { ctx, page: shop } = await anonymous(browser, { colorScheme: 'light' });
    await ctx.addCookies([{ name: 'tix_theme', value: 'light', url: BASE }]);
    await expect
      .poll(async () => {
        await shop.goto('/');
        return isDark(shop);
      })
      .toBe(true);
    await expect(shop.getByTestId('theme-switcher')).toHaveCount(0);
    expect(await (await ctx.request.get('/')).text()).toMatch(/<html[^>]*class="dark"/);
    // Fixed dark: one browser bar colour, the dark page background (not the brand colour).
    await expect(shop.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0a0a0a');
    await shop.goto('/de');
    expect(await isDark(shop)).toBe(true);
    await expect(shop.getByTestId('theme-switcher')).toHaveCount(0);
    await ctx.close();

    // Admin portal: its own switch, not the shop's fixed theme (OS light → light).
    const admin = await browser.newContext({
      storageState: AUTH_FILE,
      baseURL: BASE,
      colorScheme: 'light',
    });
    const adminPage = await admin.newPage();
    await adminPage.goto('/admin');
    expect(await isDark(adminPage)).toBe(false);
    await expect(adminPage.getByTestId('theme-switcher').first()).toBeVisible();
    // Soft navigation shop -> admin keeps working (area is re-evaluated on the client).
    await adminPage.goto('/');
    expect(await isDark(adminPage)).toBe(true);
    // Client-side navigation shop -> admin -> back (no reload): the area is re-evaluated.
    await adminPage.evaluate(() => ((window as unknown as { __soft: number }).__soft = 1));
    await adminPage
      .getByRole('button', { name: /dashboard/i })
      .last()
      .click();
    await adminPage.getByRole('menuitem', { name: 'Dashboard' }).click();
    await expect(adminPage).toHaveURL(/\/admin/);
    await expect(adminPage.locator('html')).toHaveAttribute('data-area', 'admin');
    await expect.poll(() => isDark(adminPage)).toBe(false);
    await adminPage.goBack();
    await expect(adminPage.locator('html')).toHaveAttribute('data-area', 'shop');
    await expect.poll(() => isDark(adminPage)).toBe(true);
    expect(await adminPage.evaluate(() => (window as unknown as { __soft?: number }).__soft)).toBe(
      1,
    );
    await adminPage
      .getByRole('button', { name: /dashboard/i })
      .last()
      .click();
    await expect(adminPage.getByRole('menuitemradio', { name: 'Dark' })).toHaveCount(0);
    await adminPage.keyboard.press('Escape');
    await adminPage.goto('/admin');
    expect(await isDark(adminPage)).toBe(false);
    await admin.close();

    await saveBranding(page, { themeMode: 'ALWAYS_LIGHT' });
    const dark = await anonymous(browser, { colorScheme: 'dark' });
    await expect
      .poll(async () => {
        await dark.page.goto('/');
        return isDark(dark.page);
      })
      .toBe(false);
    await expect(dark.page.getByTestId('theme-switcher')).toHaveCount(0);
    // Fixed light: one browser bar colour, the brand colour.
    await expect(dark.page.locator('meta[name="theme-color"]')).toHaveCount(1);
    await dark.ctx.close();
  });

  test('visitor choice with default light: no cookie renders light, switch stays available', async ({
    browser,
    page,
  }) => {
    await saveBranding(page, { themeMode: 'VISITOR_CHOICE', defaultTheme: 'LIGHT' });
    const { ctx, page: shop } = await anonymous(browser, { colorScheme: 'dark' });
    await expect
      .poll(async () => {
        await shop.goto('/');
        return isDark(shop);
      })
      .toBe(false);
    expect(await (await ctx.request.get('/')).text()).not.toMatch(/<html[^>]*class="dark"/);
    const toggle = shop.getByTestId('theme-switcher');
    await expect(toggle).toHaveAttribute('aria-label', /Colour theme: Light/);
    // "System" is a real choice now (explicit cookie) and follows the dark OS setting.
    await toggle.click();
    await shop.getByRole('menuitemradio', { name: 'System' }).click();
    await expect.poll(() => isDark(shop)).toBe(true);
    expect((await ctx.cookies()).find((c) => c.name === 'tix_theme')?.value).toBe('system');
    await shop.reload();
    expect(await isDark(shop)).toBe(true);
    // Back to the default: the cookie is dropped again.
    await shop.getByTestId('theme-switcher').click();
    await shop.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect.poll(() => isDark(shop)).toBe(false);
    expect((await ctx.cookies()).find((c) => c.name === 'tix_theme')).toBeUndefined();
    await ctx.close();

    // Default dark.
    await saveBranding(page, { defaultTheme: 'DARK' });
    const darkDefault = await anonymous(browser, { colorScheme: 'light' });
    await expect
      .poll(async () => {
        await darkDefault.page.goto('/');
        return isDark(darkDefault.page);
      })
      .toBe(true);
    await darkDefault.ctx.close();
  });

  test('logo height scales, header grows, phones scale down; sponsors rotate', async ({
    browser,
    page,
  }) => {
    await saveBranding(page, {
      themeMode: 'VISITOR_CHOICE',
      defaultTheme: 'SYSTEM',
      logoHeight: '40',
    });
    // Upload the logo and two sponsors through the pickers.
    await page.goto('/admin/settings/appearance');
    const form = brandingForm(page);
    await form
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: gradientPng(320, 80) });
    await expect(form.getByRole('button', { name: 'Remove', exact: true }).first()).toBeVisible();
    await saved(form);

    const sForm = sponsorsForm(page);
    const sw = sForm.getByRole('switch').first();
    if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
    await sForm.locator('input[name="label.en"]').fill('Supported by');
    await sForm.locator('input[name="label.de"]').fill('Unterstützt von');
    await sForm.locator('#height').fill('40');
    const sponsors = [
      { url: 'https://sponsor-one.example.org', alt: 'Sponsor One', w: 400, h: 100 },
      { url: '/events', alt: 'Sponsor Two', w: 200, h: 100 },
    ];
    for (const [i, s] of sponsors.entries()) {
      await sForm.getByRole('button', { name: 'Add sponsor' }).click();
      const row = sForm.getByTestId('sponsor-row').nth(i);
      await row.locator('input[type="file"]').setInputFiles({
        name: `s${i}.png`,
        mimeType: 'image/png',
        buffer: gradientPng(s.w, s.h, i + 1),
      });
      await expect(row.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
      await row.locator(`input[name="item.${i}.url"]`).fill(s.url);
      await row.locator(`input[name="item.${i}.duration"]`).fill('1');
      await row.locator(`input[name="item.${i}.alt.en"]`).fill(s.alt);
    }
    // Validation keeps the input: a link without alt text in the default language is rejected.
    await sForm.locator('input[name="item.1.alt.en"]').fill('');
    await sForm.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sForm.locator('input[name="item.1.alt.en"]')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(sForm.locator('input[name="item.0.url"]')).toHaveValue(sponsors[0]!.url);
    await sForm.locator('input[name="item.1.alt.en"]').fill('Sponsor Two');
    // Order: swap and swap back (up / down buttons).
    await sForm.getByTestId('sponsor-row').nth(1).getByRole('button', { name: 'Move up' }).click();
    await expect(sForm.locator('input[name="item.0.alt.en"]')).toHaveValue('Sponsor Two');
    await sForm.getByTestId('sponsor-row').nth(1).getByRole('button', { name: 'Move up' }).click();
    await expect(sForm.locator('input[name="item.0.alt.en"]')).toHaveValue('Sponsor One');
    await saved(sForm);

    // Desktop.
    const { ctx, page: shop } = await anonymous(browser, {
      viewport: { width: 1280, height: 800 },
    });
    const csp = await collectCsp(shop);
    await expect
      .poll(async () => {
        await shop.goto('/');
        return shop.getByTestId('header-sponsors').count();
      })
      .toBe(1);
    const region = shop.getByTestId('header-sponsors');
    await expect(region).toHaveAttribute('aria-live', 'off');
    const items = region.locator('[data-active]');
    await expect(items).toHaveCount(2);
    const links = await region
      .locator('a')
      .evaluateAll((els) =>
        els.map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
      );
    expect(links).toEqual([
      ['https://sponsor-one.example.org', '_blank', 'noopener sponsored'],
      ['/events', '_blank', 'noopener sponsored'],
    ]);
    // Rotation: the active entry changes by itself (1 s each).
    const active = () =>
      items.evaluateAll((els) => els.findIndex((e) => e.getAttribute('data-active') === 'true'));
    expect(await active()).toBe(0);
    await expect.poll(active, { timeout: 5000 }).toBe(1);
    await expect.poll(active, { timeout: 5000 }).toBe(0);
    // Hover pauses.
    await region.hover();
    const frozen = await active();
    await shop.waitForTimeout(2500);
    expect(await active()).toBe(frozen);
    await shop.mouse.move(5, 400);
    await expect.poll(async () => (await active()) !== frozen, { timeout: 5000 }).toBe(true);
    // Logo heights: 40 px; the header grows with it.
    const logo = shop.locator('header a').first().locator('img');
    const box = await logo.boundingBox();
    expect(Math.round(box!.height)).toBe(40);
    // Desktop: the sponsors sit directly next to the logo (not centred, not behind the nav link).
    const sponsorBox = await region.boundingBox();
    const navBox = await shop.locator('header nav').boundingBox();
    expect(sponsorBox!.x - (box!.x + box!.width)).toBeLessThan(40);
    expect(navBox!.x).toBeGreaterThan(sponsorBox!.x);
    // The label sits ABOVE the banner (not before it), inside the sponsor block.
    const labelAboveBanner = async () => {
      const labelBox = await region.getByText('Supported by').boundingBox();
      const imgBox = await region.locator('[data-active="true"] img').boundingBox();
      expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(imgBox!.y + 0.5);
      expect(labelBox!.x).toBeGreaterThanOrEqual(sponsorBox!.x - 0.5);
    };
    await labelAboveBanner();
    if (SHOTS) {
      await region.hover();
      await shop.screenshot({
        path: `${SHOTS}/header-desktop-light.png`,
        clip: { x: 0, y: 0, width: 1280, height: 140 },
      });
      await ctx.addCookies([{ name: 'tix_theme', value: 'dark', url: BASE }]);
      await shop.reload();
      await region.hover();
      await shop.screenshot({
        path: `${SHOTS}/header-desktop-dark.png`,
        clip: { x: 0, y: 0, width: 1280, height: 140 },
      });
      await ctx.addCookies([{ name: 'tix_theme', value: 'light', url: BASE }]);
      await shop.reload();
      await shop.mouse.move(5, 400);
    }
    expect(await csp()).toEqual([]);

    // Phone: no horizontal scroll, sponsor visible, images scaled to 75 %.
    await shop.setViewportSize({ width: 375, height: 800 });
    await shop.goto('/');
    const fit = () =>
      shop.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
    expect(await fit()).toBe(true);
    const phoneRegion = shop.getByTestId('header-sponsors');
    const sBox = await phoneRegion.boundingBox();
    expect(sBox!.width).toBeGreaterThan(40);
    expect(Math.round((await logo.boundingBox())!.height)).toBe(30);
    const activeImg = phoneRegion.locator('[data-active="true"] img');
    const imgBox = await activeImg.boundingBox();
    expect(imgBox!.height).toBeLessThanOrEqual(30.5);
    {
      const labelBox = await phoneRegion.getByText('Supported by').boundingBox();
      expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(imgBox!.y + 0.5);
      expect(labelBox!.height).toBeLessThanOrEqual(14);
    }
    if (SHOTS) {
      await shop.screenshot({
        path: `${SHOTS}/header-mobile-light-logo40.png`,
        clip: { x: 0, y: 0, width: 375, height: 90 },
      });
    }
    // Signed-in admin (dashboard button in the header) on a phone: still no horizontal scroll.
    const staff = await browser.newContext({
      storageState: AUTH_FILE,
      baseURL: BASE,
      viewport: { width: 375, height: 800 },
    });
    const staffPage = await staff.newPage();
    await staffPage.goto('/');
    await expect(staffPage.getByTestId('header-sponsors')).toBeVisible();
    expect(
      await staffPage.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await staff.close();
    // The widest case: large logo + banner, with the German label, still fits.
    await saveBranding(page, { logoHeight: '120' });
    await expect
      .poll(async () => {
        await shop.goto('/de');
        return Math.round((await logo.boundingBox())!.height);
      })
      .toBe(56);
    expect(await fit()).toBe(true);
    await shop.setViewportSize({ width: 1280, height: 800 });
    await shop.goto('/');
    expect(Math.round((await logo.boundingBox())!.height)).toBe(120);
    if (SHOTS) {
      await shop.screenshot({
        path: `${SHOTS}/header-desktop-logo120.png`,
        clip: { x: 0, y: 0, width: 1280, height: 220 },
      });
    }
    await ctx.close();

    // Reduced motion: no automatic rotation, manual buttons work.
    const reduced = await anonymous(browser, { reducedMotion: 'reduce' });
    await reduced.page.goto('/');
    const rRegion = reduced.page.getByTestId('header-sponsors');
    const rActive = () =>
      rRegion
        .locator('[data-active]')
        .evaluateAll((els) => els.findIndex((e) => e.getAttribute('data-active') === 'true'));
    await expect(rRegion.getByRole('button', { name: 'Next sponsor' })).toBeVisible();
    await reduced.page.waitForTimeout(2600);
    expect(await rActive()).toBe(0);
    await rRegion.getByRole('button', { name: 'Next sponsor' }).click();
    expect(await rActive()).toBe(1);
    await rRegion.getByRole('button', { name: 'Previous sponsor' }).click();
    expect(await rActive()).toBe(0);
    await reduced.ctx.close();

    // Mobile and dark screenshots for review.
    if (SHOTS) {
      const dark = await anonymous(browser, {
        colorScheme: 'dark',
        viewport: { width: 390, height: 800 },
      });
      await dark.ctx.addCookies([{ name: 'tix_theme', value: 'dark', url: BASE }]);
      await dark.page.goto('/');
      await dark.page.screenshot({
        path: `${SHOTS}/header-mobile-dark.png`,
        clip: { x: 0, y: 0, width: 390, height: 120 },
      });
      await dark.page.goto('/de');
      await dark.page.screenshot({
        path: `${SHOTS}/header-mobile-dark-de.png`,
        clip: { x: 0, y: 0, width: 390, height: 120 },
      });
      await dark.ctx.addCookies([{ name: 'tix_theme', value: 'light', url: BASE }]);
      await dark.page.goto('/');
      await dark.page.screenshot({
        path: `${SHOTS}/header-mobile-light.png`,
        clip: { x: 0, y: 0, width: 390, height: 120 },
      });
      await dark.ctx.close();
    }
    await saveBranding(page, { logoHeight: '40' });
    if (SHOTS) {
      await page.goto('/admin/settings/appearance#sponsors');
      await page.screenshot({ path: `${SHOTS}/settings-appearance-sponsors.png` });
    }
  });

  // Logo, label and two sponsors stay configured from the previous test (restored in afterAll).
  test('header never wraps: one row for visitors, cart timer and admins on every phone width', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    const SHOT_DIR = process.env.E2E_HEADER_SHOTS_DIR ?? SHOTS;
    const WIDTHS = [360, 375, 390, 414, 480, 639, 640, 768, 1024];
    const widthsFor = (locale: string) => (locale ? [360, 390, 640] : WIDTHS);
    const MAX_HEIGHT = 66; // 20 px padding + 10 px label + 4 px gap + 30 px phone banner + border

    const seatInCart = async (page: Page, index: number) => {
      await page.goto(`/events/${EVENT_SLUG}`);
      await expect(page.locator('g[data-seat]').first()).toBeAttached({ timeout: 30_000 });
      const ids = await clickableSeatIds(page);
      await clickSeat(page, ids[index]!);
      await expect(page.locator('header a[href$="/cart"]')).toContainText(/\d+:\d\d/);
    };
    const measure = (page: Page) =>
      page.evaluate(() => {
        const header = document.querySelector('header')!;
        const hb = header.getBoundingClientRect();
        const controls = [...header.querySelectorAll('a, button')]
          .map((e) => e.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0);
        const centres = controls.map((r) => r.top + r.height / 2);
        return {
          height: Math.round(hb.height * 10) / 10,
          fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          rightmost: Math.max(...controls.map((r) => r.right)),
          rowSpread: Math.max(...centres) - Math.min(...centres),
          viewport: document.documentElement.clientWidth,
        };
      });
    const assertOneRow = async (page: Page, label: string, results: string[]) => {
      const m = await measure(page);
      results.push(`${label}: height ${m.height}`);
      expect(m.fits, `${label}: horizontal scroll`).toBe(true);
      expect(m.rightmost, `${label}: control beyond the viewport`).toBeLessThanOrEqual(m.viewport);
      // Single row: every control is vertically centred around the same line (a second row would
      // be 30+ px away), and the header is not taller than one phone row.
      expect(m.rowSpread, `${label}: second row`).toBeLessThan(24);
      expect(m.height, `${label}: header height`).toBeLessThanOrEqual(
        (page.viewportSize()?.width ?? 0) < 640 ? MAX_HEIGHT : 80,
      );
    };

    // The page may not be hydrated right after navigation (a click then opens nothing) and an open
    // menu can be re-rendered away: repeat open + choose until the item was selected.
    const openMenu = async (page: Page, trigger: ReturnType<Page['locator']>) => {
      await expect(async () => {
        if ((await page.getByRole('menu').count()) === 0) await trigger.click({ timeout: 2000 });
        await expect(page.getByRole('menu')).toHaveCount(1, { timeout: 1500 });
      }).toPass({ timeout: 15_000 });
    };
    const choose = async (
      page: Page,
      trigger: ReturnType<Page['locator']>,
      item: string,
    ): Promise<void> => {
      await expect(async () => {
        if ((await page.getByRole('menu').count()) === 0) await trigger.click({ timeout: 2000 });
        await page.getByRole('menuitemradio', { name: item }).click({ timeout: 2000 });
      }).toPass({ timeout: 20_000 });
      await expect(page.getByRole('menu')).toHaveCount(0);
    };

    const results: string[] = [];
    const anon = await anonymous(browser, { viewport: { width: 390, height: 800 } });
    const staff = await browser.newContext({
      storageState: AUTH_FILE,
      baseURL: BASE,
      viewport: { width: 390, height: 800 },
    });
    const shop = anon.page;
    const staffPage = await staff.newPage();
    // A hanging action must not eat the whole test timeout.
    shop.setDefaultTimeout(20_000);
    staffPage.setDefaultTimeout(20_000);
    try {
      // Without cart.
      for (const [name, p] of [
        ['anonymous', shop],
        ['admin', staffPage],
      ] as const) {
        for (const locale of ['', '/de']) {
          for (const w of widthsFor(locale)) {
            await p.setViewportSize({ width: w, height: 800 });
            // The language cookie would redirect the unprefixed URL to the last visited language.
            if (!locale) await p.context().clearCookies({ name: 'tix_locale' });
            await p.goto(`${locale}/`);
            await expect(p.getByTestId('header-sponsors')).toBeVisible();
            await assertOneRow(p, `${name} ${locale || '/en'} ${w}px`, results);
          }
        }
      }
      // With a seat (badge + countdown), anonymous and admin.
      await seatInCart(shop, 80);
      await seatInCart(staffPage, 81);
      for (const [name, p] of [
        ['anonymous+cart', shop],
        ['admin+cart', staffPage],
      ] as const) {
        for (const locale of ['', '/de']) {
          for (const w of widthsFor(locale)) {
            await p.setViewportSize({ width: w, height: 800 });
            // The language cookie would redirect the unprefixed URL to the last visited language.
            if (!locale) await p.context().clearCookies({ name: 'tix_locale' });
            await p.goto(`${locale}/`);
            await expect(p.locator('header a[href$="/cart"]')).toContainText(/\d+:\d\d/);
            await assertOneRow(p, `${name} ${locale || '/en'} ${w}px`, results);
          }
        }
      }
      console.log(`[header] ${results.join(' | ')}`);

      // Phones: ONE combined menu; from 640 px the two separate switchers.
      await shop.setViewportSize({ width: 375, height: 800 });
      await shop.context().clearCookies({ name: 'tix_locale' });
      await shop.goto('/');
      await expect(shop.getByTestId('display-menu')).toBeVisible();
      await expect(shop.getByTestId('theme-switcher')).toBeHidden();
      await expect(shop.locator('header button[aria-label^="Language:"]')).toBeHidden();
      // The opened menu paints above the page content (event cards, seat chart), in both themes.
      const menuOnTop = async (page: Page) => {
        await expect(page.getByRole('menuitemradio').first()).toBeVisible();
        // Wait for the open animation: a half-transparent menu is not a stacking problem.
        await page.waitForFunction(() =>
          document.getAnimations().every((an) => an.playState !== 'running'),
        );
        const items = page.getByRole('menuitemradio');
        for (let i = 0; i < (await items.count()); i += 1) {
          const box = (await items.nth(i).boundingBox())!;
          const top = await page.evaluate(
            ([x, y]) => {
              const el = document.elementFromPoint(x!, y!);
              return !!el?.closest('[role="menuitemradio"]');
            },
            [box.x + box.width / 2, box.y + box.height / 2],
          );
          expect(top, `menu item ${i} is covered by page content`).toBe(true);
        }
      };
      for (const path of ['/', `/events/${EVENT_SLUG}`]) {
        for (const theme of ['light', 'dark']) {
          await shop.context().addCookies([{ name: 'tix_theme', value: theme, url: BASE }]);
          await shop.goto(path);
          await openMenu(shop, shop.getByTestId('display-menu'));
          await menuOnTop(shop);
          if (SHOT_DIR && theme === 'light') {
            await shop.screenshot({
              path: `${SHOT_DIR}/${path === '/' ? 'anon-menu-open-375' : 'event-menu-open-375'}.png`,
              clip: { x: 0, y: 0, width: 375, height: 420 },
            });
          }
          await shop.keyboard.press('Escape');
          await expect(shop.getByRole('menu')).toHaveCount(0);
        }
      }
      await shop.context().clearCookies({ name: 'tix_theme' });
      await shop.goto('/');
      await choose(shop, shop.getByTestId('display-menu'), 'Dark');
      await expect.poll(() => isDark(shop)).toBe(true);
      await choose(shop, shop.getByTestId('display-menu'), 'Light');
      await expect.poll(() => isDark(shop)).toBe(false);
      await choose(shop, shop.getByRole('button', { name: 'Language & appearance' }), 'Deutsch');
      await expect(shop).toHaveURL(/\/de(\/|$)/);
      await expect(shop.getByRole('button', { name: 'Sprache & Darstellung' })).toBeVisible();
      await choose(shop, shop.getByRole('button', { name: 'Sprache & Darstellung' }), 'English');
      await expect(shop).not.toHaveURL(/\/de(\/|$)/);
      // Admins: no separate button on phones, the dashboard dropdown carries language + theme.
      await staffPage.setViewportSize({ width: 375, height: 800 });
      await staffPage.context().clearCookies({ name: 'tix_locale' });
      await staffPage.goto('/');
      await expect(staffPage.getByTestId('display-menu')).toBeHidden();
      await openMenu(staffPage, staffPage.getByRole('button', { name: 'To dashboard' }).last());
      await expect(staffPage.getByRole('menuitemradio', { name: 'Deutsch' })).toBeVisible();
      await staffPage.keyboard.press('Escape');
      await expect(staffPage.getByRole('menu')).toHaveCount(0);
      await choose(
        staffPage,
        staffPage.getByRole('button', { name: 'To dashboard' }).last(),
        'Dark',
      );
      await expect.poll(() => isDark(staffPage)).toBe(true);
      await choose(
        staffPage,
        staffPage.getByRole('button', { name: 'To dashboard' }).last(),
        'Light',
      );
      await expect.poll(() => isDark(staffPage)).toBe(false);
      await staffPage.setViewportSize({ width: 768, height: 800 });
      // From 640 px the dropdown no longer repeats language / theme (the header has the switchers).
      await openMenu(staffPage, staffPage.getByRole('button', { name: 'To dashboard' }).last());
      await expect(staffPage.getByRole('menuitem', { name: 'Dashboard' })).toBeVisible();
      await expect(staffPage.getByRole('menuitemradio', { name: 'Deutsch' })).toBeHidden();
      await staffPage.keyboard.press('Escape');
      await shop.setViewportSize({ width: 768, height: 800 });
      await expect(shop.getByTestId('display-menu')).toBeHidden();
      await expect(shop.getByTestId('theme-switcher')).toBeVisible();
      await expect(shop.locator('header button[aria-label^="Language:"]')).toBeVisible();

      if (SHOT_DIR) {
        for (const [name, p] of [
          ['anon-cart', shop],
          ['admin-cart', staffPage],
        ] as const) {
          for (const w of [375, 390]) {
            for (const theme of ['light', 'dark']) {
              const ctx = p.context();
              await ctx.addCookies([{ name: 'tix_theme', value: theme, url: BASE }]);
              await p.setViewportSize({ width: w, height: 800 });
              await p.goto('/');
              await expect(p.locator('header a[href$="/cart"]')).toContainText(/\d+:\d\d/);
              await p.screenshot({
                path: `${SHOT_DIR}/${name}-${w}-${theme}.png`,
                clip: { x: 0, y: 0, width: w, height: 90 },
              });
            }
          }
        }
        // Fresh visitors and admins WITHOUT a cart (the sessions above hold a seat).
        for (const [name, state] of [
          ['anon-nocart', ANON],
          ['admin-nocart', AUTH_FILE],
        ] as const) {
          const fresh = await browser.newContext({ storageState: state, baseURL: BASE });
          const p = await fresh.newPage();
          for (const w of [375, 390]) {
            for (const theme of ['light', 'dark']) {
              await fresh.addCookies([{ name: 'tix_theme', value: theme, url: BASE }]);
              await p.setViewportSize({ width: w, height: 800 });
              await p.goto('/');
              await expect(p.getByTestId('header-sponsors')).toBeVisible();
              await p.screenshot({
                path: `${SHOT_DIR}/${name}-${w}-${theme}.png`,
                clip: { x: 0, y: 0, width: w, height: 90 },
              });
            }
          }
          await fresh.close();
        }
      }
    } finally {
      await anon.ctx.close();
      await staff.close();
    }
  });

  test('e-mail addresses in shop HTML carry the Cloudflare opt-out markers', async ({
    browser,
    page,
  }) => {
    await page.goto('/admin/settings/appearance');
    const form = brandingForm(page);
    const editor = form.locator('.ProseMirror').first();
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Questions? kontakt@example.org ');
    await page.keyboard.type('Write us');
    for (let i = 0; i < 'Write us'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    await form.getByRole('button', { name: 'Add link' }).click();
    await page.locator('#rte-link').fill('mailto:team@example.org');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await saved(form);
    const { ctx, page: shop } = await anonymous(browser);
    const csp = await collectCsp(shop);
    await expect
      .poll(async () => (await (await ctx.request.get('/')).text()).includes('kontakt@example.org'))
      .toBe(true);
    const html = await (await ctx.request.get('/')).text();
    expect(html).toContain('<!--email_off-->kontakt@example.org<!--/email_off-->');
    // A mailto link is wrapped as a whole (its href stays intact).
    expect(html).toMatch(
      /<!--email_off--><a href="mailto:team@example\.org"[^>]*>Write us<\/a><!--\/email_off-->/,
    );
    await shop.goto('/');
    await expect(shop.locator('footer')).toContainText('kontakt@example.org');
    expect(await csp()).toEqual([]);
    await ctx.close();
  });
});
