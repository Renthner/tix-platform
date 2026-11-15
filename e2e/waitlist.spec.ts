import { expect, test } from '@playwright/test';
import { EVENT_SLUG } from './helpers';

// Waiting list: sign-up (double opt-in), admin overview, invalid confirmation link, and the event
// calendar download. The "sold out" card itself is covered by the integration test (selling out
// the demo event would need every seat); here the API is called like the form does.

async function eventId(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/admin/events');
  const link = page.locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' }).first();
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec((await link.getAttribute('href')) ?? '')?.[1];
  expect(id, `event id of ${EVENT_SLUG}`).toBeTruthy();
  return id!;
}

test('joining the waiting list creates an unconfirmed entry the admin sees and can export/remove', async ({
  page,
}) => {
  const id = await eventId(page);
  const email = `fan.${Date.now()}@example.org`;
  const join = await page.request.post(`/api/events/${id}/waitlist`, {
    data: { email, firstName: 'Fan', quantity: 2, locale: 'en' },
  });
  expect(join.status()).toBe(200);
  expect(await join.json()).toEqual({ status: 'CONFIRMATION_SENT' });

  // The honeypot answers like a success but stores nothing.
  const bot = await page.request.post(`/api/events/${id}/waitlist`, {
    data: { email: `bot.${Date.now()}@example.org`, quantity: 1, website: 'http://spam' },
  });
  expect(bot.status()).toBe(200);

  await page.goto(`/admin/events/${id}/sales`);
  const card = page.locator('[data-slot="waitlist-admin"]');
  const row = card.locator('[data-slot="waitlist-row"]', { hasText: email });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Awaiting confirmation');
  await expect(card.getByText(/bot\..*@example\.org/)).toHaveCount(0);

  const csv = await page.request.get(`/api/admin/events/${id}/waitlist`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect(await csv.text()).toContain(email);

  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
});

test('an invalid confirmation link is explained, not accepted', async ({ page }) => {
  await page.goto('/waitlist/confirm?token=nonsense');
  await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
});

test('the event page offers a calendar file (text/calendar)', async ({ page }) => {
  await page.goto(`/events/${EVENT_SLUG}`);
  const href = await page
    .getByRole('link', { name: 'Add to calendar' })
    .first()
    .getAttribute('href');
  expect(href).toMatch(/\/api\/events\/[0-9a-f-]{36}\/calendar\.ics/);
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/calendar');
  expect(await response.text()).toContain('BEGIN:VCALENDAR');
});
