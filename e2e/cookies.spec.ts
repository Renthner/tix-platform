import { expect, test } from '@playwright/test';

test('cookie notice shows on the first visit, can be dismissed and stays dismissed', async ({
  page,
}) => {
  await page.goto('/');
  const notice = page.getByTestId('cookie-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('technically necessary cookies');

  await notice.getByRole('button', { name: 'OK' }).click();
  await expect(notice).toBeHidden();

  await page.reload();
  await expect(page.locator('a[href*="/events/"]').first()).toBeVisible();
  await expect(page.getByTestId('cookie-notice')).toHaveCount(0);
});

test('the notice links to the cookie page, which lists the cart cookie', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('cookie-notice').getByRole('link', { name: 'Learn more' }).click();
  await expect(page).toHaveURL(/\/cookies$/);
  await expect(page.getByRole('heading', { name: 'Cookies', level: 1 })).toBeVisible();
  const shopCookies = page.getByTestId('cookies-shop');
  await expect(shopCookies.getByRole('cell', { name: 'tix_sid', exact: true })).toBeVisible();
  await expect(shopCookies.getByRole('cell', { name: 'tix_cookie_notice' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'IP addresses' })).toBeVisible();
});

test('the footer links to the cookie page in German as well', async ({ page }) => {
  await page.goto('/de');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Cookies' }).click();
  await expect(page).toHaveURL(/\/de\/cookies$/);
  await expect(page.getByRole('heading', { name: 'Cookies im Shop' })).toBeVisible();
});
