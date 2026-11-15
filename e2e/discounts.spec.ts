import { expect, test } from '@playwright/test';
import { openEvent } from './helpers';

test.setTimeout(90_000);

test('admin creates a discount code, the shop applies it and shows the discount line', async ({
  page,
  browser,
}) => {
  const code = `E2E${Date.now().toString(36).toUpperCase()}`;

  await page.goto('/admin/discounts');
  await expect(page.getByRole('heading', { name: 'Discount codes' })).toBeVisible();
  await page.locator('#dc-code').fill(code);
  await page.locator('#dc-value').fill('10');
  await page.getByRole('button', { name: 'Create code' }).click();
  await expect(page.getByRole('link', { name: code })).toBeVisible();

  // The admin project's storage state would sign the visitor in (and reuse the admin's cart).
  const shop = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const visitor = await shop.newPage();
    visitor.setDefaultTimeout(15_000);
    await openEvent(visitor);
    // Best available (2 tickets) respects the seat rules, unlike hand-picked seats.
    const box = visitor.locator('aside').filter({ hasText: 'Best available' });
    await box.getByRole('combobox').click();
    await visitor.getByRole('option').first().click();
    await box.getByRole('button', { name: 'Find seats' }).click();
    await expect(
      visitor
        .getByRole('listitem')
        .filter({ hasText: /Row \S+ · Seat \S+/ })
        .first(),
    ).toBeVisible();
    await visitor.getByRole('button', { name: /Continue to cart/i }).click();
    await visitor.waitForURL(/\/cart/).catch(async (err) => {
      const text = await visitor.locator('body').innerText();
      throw new Error(`no cart: ${visitor.url()} :: ${text.slice(0, 1500)}`, { cause: err });
    });
    await expect(visitor.getByTestId('discount-box')).toBeVisible();

    // An unknown code is refused with a readable message.
    await visitor.getByTestId('discount-input').fill('NOT-A-CODE');
    await visitor.getByTestId('discount-apply').click();
    await expect(visitor.getByTestId('discount-error')).toContainText('not valid');

    // The real one (any case) shows up as its own discount line.
    await visitor.getByTestId('discount-input').fill(code.toLowerCase());
    await visitor.getByTestId('discount-apply').click();
    await expect(visitor.getByTestId('cart-discount')).toBeVisible();

    await visitor.getByRole('link', { name: /Proceed to checkout/i }).click();
    await visitor.waitForURL(/\/checkout/);
    await expect(visitor.getByTestId('quote-discount')).toContainText(code);
  } finally {
    await shop.close();
  }
});
