import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, AUTH_FILE } from './helpers';

// One login for the whole run: the sign-in is rate limited (10 attempts per e-mail / 15 minutes).
setup('sign in as admin', async ({ page }) => {
  expect(ADMIN_PASSWORD, 'E2E_ADMIN_PASSWORD must be set (pnpm test:e2e does it)').not.toBe('');
  await page.goto('/admin/login');
  await page.locator('input[type=email]').fill(ADMIN_EMAIL);
  await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
  await page.locator('button[type=submit]').click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
