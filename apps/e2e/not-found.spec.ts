import { expect, test } from '@playwright/test';
import { AUTH_FILE } from './helpers';

test.describe('shop 404', () => {
  test('unknown shop URL answers 404 with the branded page (en)', async ({ page }) => {
    const res = await page.goto('/this-page-does-not-exist');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the shop' })).toBeVisible();
  });

  test('unknown shop URL answers 404 with the branded page (de)', async ({ page }) => {
    const res = await page.goto('/de/diese-seite-gibt-es-nicht');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Seite nicht gefunden' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Zurück zum Shop' })).toBeVisible();
  });

  test('unknown event slug is a 404', async ({ page }) => {
    const res = await page.goto('/events/no-such-event-xyz');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});

test.describe('admin 404 (signed in)', () => {
  test.use({ storageState: AUTH_FILE });

  test('unknown admin URL keeps the admin navigation', async ({ page }) => {
    const res = await page.goto('/admin/no-such-page-xyz');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the dashboard' })).toBeVisible();
    await expect(page.locator('a[href="/admin/orders"]').first()).toBeVisible();
  });

  test('unknown order id is a 404 inside the admin', async ({ page }) => {
    const res = await page.goto('/admin/orders/00000000-0000-0000-0000-000000000000');
    expect(res?.status()).toBe(404);
    await expect(page.locator('a[href="/admin/orders"]').first()).toBeVisible();
  });
});
