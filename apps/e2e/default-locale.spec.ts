import { expect, test, type Browser } from '@playwright/test';

// Runs last (own project): flips the shop default language, which is global state.
test.use({ locale: 'en-US' });

const lang = (page: import('@playwright/test').Page) => page.locator('html').getAttribute('lang');

/** Sets Settings → General → Default language in the admin UI. */
async function setDefaultLanguage(page: import('@playwright/test').Page, value: 'en' | 'de') {
  await page.goto('/admin/settings/general');
  const form = page.locator('form').filter({ has: page.locator('#defaultLocale') });
  await form.locator('#defaultLocale').selectOption(value);
  await form.getByRole('button', { name: 'Save' }).click();
  // Effective immediately on this instance: wait until the root answers in the new default.
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/', {
          maxRedirects: 0,
          headers: { 'accept-language': value === 'de' ? 'de-DE' : 'en-US' },
        });
        return res.status() === 200 && (await res.text()).includes(`<html lang="${value}"`);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** A fresh visitor (no cookies) with the given browser language. */
async function visitor(browser: Browser, baseURL: string, locale: string) {
  const context = await browser.newContext({ baseURL, locale });
  return { context, page: await context.newPage() };
}

test('the default language has no URL prefix, the other one has', async ({
  page,
  browser,
  baseURL,
}) => {
  // The finally-reset (UI round trips) must not be cut off by the default timeout.
  test.setTimeout(120_000);
  const base = baseURL ?? 'http://localhost:18090';
  try {
    await setDefaultLanguage(page, 'de');

    // "/" is German, "/en/" English.
    const de = await visitor(browser, base, 'de-DE');
    await de.page.goto('/');
    expect(new URL(de.page.url()).pathname).toBe('/');
    expect(await lang(de.page)).toBe('de');
    // Shop links on the German home page carry no "/de" prefix.
    const hrefs = await de.page
      .locator('a[href^="/"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    expect(hrefs.some((h) => h.startsWith('/events/'))).toBe(true);
    expect(hrefs.filter((h) => /^\/de(\/|$)/.test(h))).toEqual([]);
    // The language switcher leads to the prefixed English page.
    await de.page.getByRole('button', { name: /Sprache/ }).click();
    await de.page.getByRole('menuitemradio', { name: 'English' }).click();
    await de.page.waitForURL((u) => u.pathname === '/en' || u.pathname.startsWith('/en/'));
    expect(await lang(de.page)).toBe('en');
    await de.context.close();

    const en = await visitor(browser, base, 'de-DE');
    await en.page.goto('/en/');
    expect(new URL(en.page.url()).pathname).toMatch(/^\/en\/?$/);
    expect(await lang(en.page)).toBe('en');
    await en.context.close();

    // The default language's own prefix redirects to the unprefixed URL.
    const prefixed = await visitor(browser, base, 'de-DE');
    await prefixed.page.goto('/de/');
    expect(new URL(prefixed.page.url()).pathname).toBe('/');
    expect(await lang(prefixed.page)).toBe('de');
    await prefixed.context.close();
  } finally {
    await setDefaultLanguage(page, 'en');
  }

  const back = await visitor(browser, base, 'en-US');
  await back.page.goto('/');
  expect(new URL(back.page.url()).pathname).toBe('/');
  expect(await lang(back.page)).toBe('en');
  await back.context.close();
});
