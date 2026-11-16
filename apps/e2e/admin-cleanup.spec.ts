import { expect, test } from '@playwright/test';

// Runs with the stored admin session (see auth.setup.ts). The e2e seed (scripts/e2e/run.mjs)
// adds 30 "Pager CustomerNN" customers so the customer list has more than one page.

const rows = (page: import('@playwright/test').Page) => page.locator('tbody tr');

test('customers list pages, searches, sorts and changes the page size on the server', async ({
  page,
}) => {
  await page.goto('/admin/customers');
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  await expect(page.getByText('Page 1 of 2')).toBeVisible();

  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  expect(await rows(page).count()).toBeGreaterThanOrEqual(5);
  expect(await rows(page).count()).toBeLessThan(25);

  // Search resets the page and filters by name.
  await page.goto('/admin/customers');
  await page.getByPlaceholder(/Search by name/).fill('Customer07');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pager Customer07');
  await expect(page.getByText('Page 1 of')).toHaveCount(0);

  // Search by e-mail (substring, case-insensitive).
  await page.goto('/admin/customers?q=PAGER12%40example');
  await expect(rows(page)).toHaveCount(1);

  // Page size switcher.
  await page.goto('/admin/customers');
  await page.getByTestId('page-size-10').click();
  await expect(page).toHaveURL(/pageSize=10/);
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByText(/Page 1 of [4-9]/)).toBeVisible();

  // Sortable name column (ascending first).
  await page.goto('/admin/customers?q=Pager');
  await page.getByRole('link', { name: 'Name', exact: true }).click();
  await expect(page).toHaveURL(/sort=name/);
  await expect(page).toHaveURL(/dir=asc/);
  await expect(rows(page).first()).toContainText('Pager Customer01');
  await page.getByRole('link', { name: 'Name', exact: true }).click();
  await expect(page).toHaveURL(/dir=desc/);
  await expect(rows(page).first()).toContainText('Pager Customer30');
});

test('a confirmation is an in-page dialog, never a native confirm()', async ({ page }) => {
  const native: string[] = [];
  page.on('dialog', (dialog) => {
    native.push(dialog.message());
    void dialog.dismiss();
  });

  await page.goto('/admin/settings/security');
  const monitoring = page.locator('#monitoring');
  const generate = page.getByRole('button', { name: /Generate new token|Regenerate/ });
  await generate.click();
  await expect(monitoring.getByText('Enabled', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Remove token (disable)' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  // Cancel keeps the token.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(monitoring.getByText('Enabled', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Remove token (disable)' }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(monitoring.getByText('Disabled', { exact: true })).toBeVisible();
  expect(native).toEqual([]);
});

test('the e-mail template editor warns before leaving with unsaved changes', async ({ page }) => {
  await page.goto('/admin/email-templates');
  const edit = page.locator('a[href*="/admin/email-templates/"]').first();
  await edit.click();
  const subject = page.locator('#tpl-subject');
  await expect(subject).toBeVisible();
  const url = page.url();

  // Clean editor: navigation is not blocked.
  await page.locator('aside a[href$="/admin/orders"]').click();
  await expect(page).toHaveURL(/\/admin\/orders/);
  await page.goBack();
  await expect(subject).toBeVisible();

  await subject.fill(`${await subject.inputValue()} (edited)`);
  await page.locator('aside a[href$="/admin/orders"]').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Discard unsaved changes?');

  // Keep editing: stays, edit preserved.
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(url);
  await expect(subject).toHaveValue(/\(edited\)$/);

  // Discard: leaves.
  await page.locator('aside a[href$="/admin/orders"]').click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/\/admin\/orders/);
});

async function demoEventId(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/admin/events');
  const href = await page
    .locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' })
    .first()
    .getAttribute('href');
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  expect(id, 'demo event id').toBeTruthy();
  return id as string;
}

test('untouched guarded forms never block navigation (no false "unsaved" prompt)', async ({
  page,
}) => {
  const id = await demoEventId(page);
  const urls = [
    '/admin/settings/appearance',
    '/admin/settings/seo',
    '/admin/settings/organizer',
    `/admin/events/${id}`,
    `/admin/events/${id}/shop-page`,
    '/admin/email-templates',
  ];
  for (const url of urls) {
    await page.goto(url);
    // Past the guard's baseline delay; rich-text editors have initialised by then.
    await page.waitForTimeout(1200);
    await page.locator('aside a[href$="/admin/orders"]').click();
    await expect(page, `leaving ${url}`).toHaveURL(/\/admin\/orders/);
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  }
});

test('an edited settings form asks before an internal link is followed', async ({ page }) => {
  await page.goto('/admin/settings/seo');
  await page.waitForTimeout(1200);
  const field = page
    .locator('main form input:not([type]), main form input[type="text"], main form textarea')
    .first();
  await field.fill('Changed by the e2e guard test');
  await page.locator('aside a[href$="/admin/orders"]').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(/\/admin\/settings\/seo/);
  await expect(field).toHaveValue('Changed by the e2e guard test');
});
