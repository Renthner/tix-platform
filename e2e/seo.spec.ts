import { expect, test } from '@playwright/test';
import { EVENT_SLUG } from './helpers';

test('robots.txt hides the private areas and points to the sitemap', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.ok()).toBe(true);
  const body = await res.text();
  expect(body).toMatch(/^Disallow: \/admin$/m);
  expect(body).toMatch(/^Disallow: \/checkout$/m);
  expect(body).toMatch(/^Disallow: \/de\/admin$/m);
  expect(body).toMatch(/^Disallow: \/api\/$/m);
  expect(body).toMatch(/^Allow: \/api\/media\/$/m);
  expect(body).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
});

test('sitemap.xml lists the demo event with hreflang alternates', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.ok()).toBe(true);
  const xml = await res.text();
  expect(xml).toContain(`/events/${EVENT_SLUG}</loc>`);
  expect(xml).toContain('hreflang="de"');
  expect(xml).toContain('hreflang="x-default"');
  expect(xml).toContain('/cookies</loc>');
  expect(xml).not.toContain('/admin');
});

test('web manifest carries the shop name and theme colour', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.name).toBeTruthy();
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test('event page has canonical, hreflang, Open Graph and valid Event JSON-LD', async ({ page }) => {
  await page.goto(`/events/${EVENT_SLUG}`);
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(canonical).toMatch(new RegExp(`/events/${EVENT_SLUG}$`));
  const langs = await page
    .locator('link[rel="alternate"][hreflang]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('hreflang')));
  expect(langs).toEqual(expect.arrayContaining(['en', 'de', 'x-default']));
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    /Demo Concert/,
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', canonical!);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);

  const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
  const data = JSON.parse(raw ?? '');
  expect(data['@type']).toBe('Event');
  expect(data.name).toBe('Demo Concert');
  expect(data.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  expect(data.eventStatus).toBe('https://schema.org/EventScheduled');
  expect(data.location['@type']).toBe('Place');
  expect(data.offers['@type']).toBe('AggregateOffer');
  expect(Number(data.offers.lowPrice)).toBeLessThanOrEqual(Number(data.offers.highPrice));
  expect(data.offers.priceCurrency).toMatch(/^[A-Z]{3}$/);
});

test('private pages stay noindex', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});
