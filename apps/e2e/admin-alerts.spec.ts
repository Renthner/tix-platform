import { expect, test } from '@playwright/test';

// Runs with the stored super admin session (see auth.setup.ts).

test('alert preferences on the own account page persist and can be reset', async ({ page }) => {
  await page.goto('/admin/account');
  const section = page.locator('#alerts');
  await expect(section.getByText('Warning e-mails').first()).toBeVisible();
  const disk = section.locator('input[name="types"][value="DISK_LOW"]');
  const update = section.locator('input[name="types"][value="UPDATE_AVAILABLE"]');
  // Super admin defaults: everything except the update notice.
  await expect(disk).toBeChecked();
  await expect(update).not.toBeChecked();

  await disk.uncheck();
  await update.check();
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Warning e-mail settings saved.')).toBeVisible();

  await page.reload();
  await expect(disk).not.toBeChecked();
  await expect(update).toBeChecked();

  await section.getByRole('button', { name: 'Reset to role defaults' }).click();
  await expect(page.getByText('Back to the defaults of your role.')).toBeVisible();
  await page.reload();
  await expect(disk).toBeChecked();
  await expect(update).not.toBeChecked();
});

test('notification settings tab saves and the system page lists the alert history', async ({
  page,
}) => {
  await page.goto('/admin/settings/notifications');
  const threshold = page.locator('input[name="reviewCaseDays"]');
  await threshold.fill('5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  await page.reload();
  await expect(threshold).toHaveValue('5');
  await threshold.fill('3');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();

  await page.goto('/admin/system');
  await expect(page.getByRole('heading', { name: 'Warning history' })).toBeVisible();
});
