import { expect, test, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, openOrderAction } from './helpers';

// Admin shell: sidebar sections, hub pages, search palette, notification bell (admin session).

test('sidebar shows the always expanded sections and the hubs', async ({ page }) => {
  await page.goto('/admin');
  const nav = page.locator('aside nav');
  for (const [id, heading] of [
    ['events', 'Events'],
    ['sales', 'Sales'],
    ['onSite', 'On site'],
    ['finance', 'Finance'],
  ]) {
    await expect(nav.locator(`#admin-nav-${id}`)).toHaveText(heading);
  }
  for (const href of [
    '/admin',
    '/admin/events',
    '/admin/orders',
    '/admin/box-office',
    '/admin/banking',
    '/admin/design',
    '/admin/settings',
    '/admin/administration',
  ]) {
    await expect(nav.locator(`a[href="${href}"]`)).toBeVisible();
  }
  // No collapsible sections any more.
  await expect(nav.locator('button[aria-expanded]')).toHaveCount(0);
  await expect(nav.locator('a[href="/admin"]')).toHaveAttribute('aria-current', 'page');

  // A page behind a hub highlights the hub.
  await page.goto('/admin/media');
  await expect(nav.locator('a[href="/admin/design"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Design');
  // Former URLs of fees and waiting room lead to their settings pages.
  await page.goto('/admin/fees');
  await expect(page).toHaveURL(/\/admin\/settings\/fees$/);
  await expect(nav.locator('a[href="/admin/settings"]')).toHaveAttribute('aria-current', 'page');
  await page.goto('/admin/waiting-room');
  await expect(page).toHaveURL(/\/admin\/settings\/waitingRoom$/);
  await expect(nav.locator('a[href="/admin/settings"]')).toHaveAttribute('aria-current', 'page');
});

test('hub pages list their cards', async ({ page }) => {
  await page.goto('/admin/design');
  await expect(page.getByRole('heading', { level: 1, name: 'Design' })).toBeVisible();
  const design = page.getByTestId('hub-design');
  for (const href of [
    '/admin/settings/appearance',
    '/admin/ticket-templates',
    '/admin/email-templates',
    '/admin/settings/emailHeader',
    '/admin/media',
    '/admin/symbols',
  ]) {
    await expect(design.locator(`a[href="${href}"]`)).toBeVisible();
  }

  await page.goto('/admin/administration');
  await expect(page.getByRole('heading', { level: 1, name: 'System' })).toBeVisible();
  const admin = page.getByTestId('hub-administration');
  for (const href of [
    '/admin/users',
    '/admin/backups',
    '/admin/system',
    '/admin/audit',
    '/admin/settings/security',
    '/admin/settings/monitoring',
  ]) {
    await expect(admin.locator(`a[href="${href}"]`)).toBeVisible();
  }
});

test('settings overview lists every settings page and filters them', async ({ page }) => {
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const overview = page.getByTestId('settings-overview');
  for (const href of [
    '/admin/settings/general',
    '/admin/settings/email',
    '/admin/settings/fees',
    '/admin/settings/waitingRoom',
    '/admin/settings/paypal',
    '/admin/settings/monitoring',
  ]) {
    await expect(overview.locator(`a[href="${href}"]`)).toBeVisible();
  }
  // Field labels are searchable: "SMTP" keeps the e-mail card and hides the fees card.
  await overview.getByRole('searchbox').fill('SMTP');
  await expect(overview.locator('a[href="/admin/settings/email"]')).toBeVisible();
  await expect(overview.locator('a[href="/admin/settings/fees"]')).toHaveCount(0);
});

test('settings page: header names the page, menu groups collapse and stay remembered', async ({
  page,
}) => {
  await page.goto('/admin/settings/email');
  await expect(page.getByRole('heading', { level: 1, name: 'E-mail (SMTP)' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Settings');
  const menu = page.getByRole('navigation', { name: 'Settings areas' });
  // The group of the current page is open (visiting adds it) and has a toggle like every group.
  const communication = menu.getByRole('button', { name: /Communication/ });
  await expect(communication).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.locator('a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/admin/settings/email',
  );

  // Toggles a group; retried until hydration has attached the click handler.
  const setExpanded = async (name: RegExp, expanded: boolean) => {
    const button = menu.getByRole('button', { name });
    await expect(async () => {
      if ((await button.getAttribute('aria-expanded')) !== String(expanded)) await button.click();
      await expect(button).toHaveAttribute('aria-expanded', String(expanded), { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  };

  // Other groups are collapsed by default; a toggle opens one and the cookie keeps it open.
  const security = menu.locator('a[href="/admin/settings/security"]');
  const system = menu.getByRole('button', { name: /System/ });
  await expect(system).toHaveAttribute('aria-expanded', 'false');
  await expect(security).toBeHidden();
  await setExpanded(/System/, true);
  await expect(security).toBeVisible();
  await page.reload();
  await expect(system).toHaveAttribute('aria-expanded', 'true');
  await expect(security).toBeVisible();
  await setExpanded(/System/, false);
  await expect(security).toBeHidden();
  await page.reload();
  await expect(system).toHaveAttribute('aria-expanded', 'false');
  await expect(security).toBeHidden();

  // Fees and waiting room are regular settings pages now (in the collapsed "Sales" group).
  await setExpanded(/Sales/, true);
  for (const href of ['/admin/settings/fees', '/admin/settings/waitingRoom']) {
    await expect(menu.locator(`a[href="${href}"]`)).toBeVisible();
  }
  await setExpanded(/Sales/, false);
  await page.goto('/admin/settings/fees');
  await expect(page.getByRole('heading', { level: 1, name: 'Fees & taxes' })).toBeVisible();
});

test('settings menu: visited groups stay open, the current group can be collapsed', async ({
  page,
}) => {
  await page.goto('/admin/settings/email');
  const menu = page.getByRole('navigation', { name: 'Settings areas' });
  const communication = menu.getByRole('button', { name: /Communication/ });
  const system = menu.getByRole('button', { name: /System/ });
  await expect(communication).toHaveAttribute('aria-expanded', 'true');

  const setExpanded = async (name: RegExp, expanded: boolean) => {
    const button = menu.getByRole('button', { name });
    await expect(async () => {
      if ((await button.getAttribute('aria-expanded')) !== String(expanded)) await button.click();
      await expect(button).toHaveAttribute('aria-expanded', String(expanded), { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  };

  // Open System, go to Security: Communication was saved on the visit and stays open.
  await setExpanded(/System/, true);
  await menu.locator('a[href="/admin/settings/security"]').click();
  await expect(page).toHaveURL(/\/admin\/settings\/security$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await expect(communication).toHaveAttribute('aria-expanded', 'true');
  await expect(system).toHaveAttribute('aria-expanded', 'true');

  // Collapsed groups stay collapsed across a reload (on a page outside that group).
  await setExpanded(/Communication/, false);
  await expect(menu.locator('a[href="/admin/settings/email"]')).toBeHidden();
  await page.reload();
  await expect(communication).toHaveAttribute('aria-expanded', 'false');
  await expect(system).toHaveAttribute('aria-expanded', 'true');

  // Visiting a page of the group opens it again.
  await page.goto('/admin/settings/email');
  await expect(communication).toHaveAttribute('aria-expanded', 'true');

  // The current group can be collapsed and is not re-opened by itself.
  await setExpanded(/Communication/, false);
  await expect(menu.locator('a[href="/admin/settings/email"]')).toBeHidden();
  await expect(communication).toHaveAttribute('aria-expanded', 'false');
});

test('settings page on desktop: fixed header, menu and content scroll on their own', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const menu = page.getByTestId('settings-menu-pane');
  const content = page.getByTestId('settings-content-pane');
  // The window does not scroll: the document is exactly viewport high.
  const fitsViewport = () =>
    page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1);

  await page.goto('/admin/settings/email');
  await expect(page.getByRole('heading', { level: 1, name: 'E-mail (SMTP)' })).toBeVisible();
  expect(await fitsViewport()).toBe(true);

  // A long page: the content pane scrolls, the page header stays in view.
  await page.goto('/admin/settings/checkout');
  const heading = page.getByRole('heading', { level: 1, name: 'Cart & seats' });
  await expect(heading).toBeVisible();
  expect(await fitsViewport()).toBe(true);
  expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await content.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(heading).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Expand every group so the menu is taller than its pane, then scroll it a bit.
  const menuNav = page.getByRole('navigation', { name: 'Settings areas' });
  for (const button of await menuNav.locator('button[aria-expanded]').all()) {
    await expect(async () => {
      if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
      await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  }
  expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await menu.evaluate((el) => {
    el.scrollTop = 120;
  });
  // Bring the target link into view first (the click would scroll the pane otherwise).
  const securityLink = menu.locator('a[href="/admin/settings/security"]');
  await securityLink.scrollIntoViewIfNeeded();
  const menuTop = await menu.evaluate((el) => el.scrollTop);
  expect(menuTop).toBeGreaterThan(0);
  // The position is saved once per frame: wait for it before navigating.
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem('tix-settings-menu-scroll')))
    .toBe(String(Math.round(menuTop)));

  // Another settings page: the menu keeps its position, the content starts at the top.
  await securityLink.click();
  await expect(page).toHaveURL(/\/admin\/settings\/security$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  const after = await menu.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - menuTop)).toBeLessThanOrEqual(2);
  expect(await content.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

async function demoEventBase(page: Page): Promise<string> {
  await page.goto('/admin/events');
  const href = await page
    .locator('a[href^="/admin/events/"]', { hasText: 'Demo Concert' })
    .first()
    .getAttribute('href');
  const id = /\/admin\/events\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  expect(id, 'demo event id').toBeTruthy();
  return `/admin/events/${id}`;
}

const EVENT_MENU_SEGMENTS = [
  '',
  '/details',
  '/seating',
  '/pricing',
  '/fees',
  '/sales',
  '/access-codes',
  '/waiting-room',
  '/shop-page',
  '/ticket',
  '/wallet',
  '/communication',
  '/check-in',
  '/status',
];

test('event overview: key figures, grouped menu, actions menu and breadcrumb', async ({ page }) => {
  const base = await demoEventBase(page);
  await page.goto(base);
  await expect(page.getByTestId('event-overview')).toBeVisible();
  // The e2e admin is a super-admin: money figures are shown as well.
  for (const kpi of ['sold', 'reserved', 'available', 'revenue']) {
    await expect(page.getByTestId(`event-kpi-${kpi}`)).toBeVisible();
  }
  await expect(page.getByTestId('event-quick-links')).toBeVisible();
  // The publish form is on the overview too.
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Events');

  const menu = page.getByRole('navigation', { name: 'Event sections' });
  for (const heading of ['Setup', 'Sales', 'Presentation', 'Operations']) {
    await expect(menu.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  for (const segment of EVENT_MENU_SEGMENTS) {
    await expect(menu.locator(`a[href="${base}${segment}"]`)).toBeVisible();
  }
  // Always expanded: no toggles. Only the overview is current on the root URL.
  await expect(menu.locator('button[aria-expanded]')).toHaveCount(0);
  await expect(menu.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(menu.locator('a[aria-current="page"]')).toHaveAttribute('href', base);

  // Header actions menu (retried until hydration has attached the trigger).
  await expect(async () => {
    // Only open it when closed: a retry must not close the menu an earlier attempt opened.
    if (!(await page.getByRole('menu').isVisible()))
      await page.getByTestId('event-actions').click();
    await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole('menuitem', { name: 'Export' })).toHaveAttribute(
    'href',
    `/api${base}/export`,
  );
  await page.keyboard.press('Escape');

  // "Details" shows the details form and becomes the current entry.
  await menu.locator(`a[href="${base}/details"]`).click();
  await expect(page).toHaveURL(new RegExp(`${base}/details$`));
  await expect(page.locator('#subtitle')).toBeVisible();
  await expect(menu.locator('a[aria-current="page"]')).toHaveAttribute('href', `${base}/details`);
  await expect(page.getByTestId('event-overview')).toHaveCount(0);
});

test('event page on desktop: fixed header, menu and content scroll on their own', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const base = await demoEventBase(page);
  const menu = page.getByTestId('event-menu-pane');
  const content = page.getByTestId('event-content-pane');
  const heading = page.getByRole('heading', { level: 1, name: /Demo Concert/ });
  const fitsViewport = () =>
    page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1);

  // The details form is longer than the pane: the content pane scrolls, the header stays.
  await page.goto(`${base}/details`);
  await expect(page.locator('#subtitle')).toBeVisible();
  expect(await fitsViewport()).toBe(true);
  expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await content.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(heading).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // A low window makes the menu taller than its pane; its position survives a page change.
  await page.setViewportSize({ width: 1440, height: 560 });
  await expect(async () => {
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  }).toPass({ timeout: 5_000 });
  await menu.evaluate((el) => {
    el.scrollTop = 60;
  });
  const statusLink = menu.locator(`a[href="${base}/status"]`);
  await statusLink.scrollIntoViewIfNeeded();
  const menuTop = await menu.evaluate((el) => el.scrollTop);
  expect(menuTop).toBeGreaterThan(0);
  // The position is saved once per frame: wait for it before navigating.
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem('tix-event-menu-scroll')))
    .toBe(String(Math.round(menuTop)));
  await statusLink.click();
  await expect(page).toHaveURL(new RegExp(`${base}/status$`));
  await expect(menu.locator('a[aria-current="page"]')).toHaveAttribute('href', `${base}/status`);
  expect(await fitsViewport()).toBe(true);
  const after = await menu.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - menuTop)).toBeLessThanOrEqual(2);
  expect(await content.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('Ctrl+K palette finds settings pages and orders', async ({ page }) => {
  // An existing order (placed by the shop project).
  await page.goto('/admin/orders');
  const row = page.locator('table tbody tr', { hasText: 'eva.e2e@example.org' }).first();
  await expect(row).toBeVisible();
  const orderNumber = (await row.locator('a[href^="/admin/orders/"]').first().innerText()).trim();
  expect(orderNumber).not.toBe('');

  await page.goto('/admin');
  await expect(page.getByTestId('admin-search-button')).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('admin-search');
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox');
  await expect(input).toBeFocused();

  // Field labels of the settings pages are searchable: "SMTP" leads to the e-mail tab.
  await input.fill('SMTP');
  const smtp = palette.getByRole('option').filter({ hasText: 'SMTP' }).first();
  await expect(smtp).toBeVisible();
  await expect(input).toHaveAttribute('aria-activedescendant', /.+/);
  await input.press('Enter');
  await expect(page).toHaveURL(/\/admin\/settings\/email$/);

  // Live search: order number.
  // Right after the client-side navigation the button may not be hydrated yet: retry the click.
  await expect(async () => {
    await page.getByTestId('admin-search-button').click();
    await expect(palette).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await palette.getByRole('combobox').fill(orderNumber);
  const hit = palette.getByRole('option').filter({ hasText: orderNumber }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(/\/admin\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByText(orderNumber).first()).toBeVisible();
});

test('search API checks the session and the query', async ({ page, browser }) => {
  await page.goto('/admin');
  const short = await page.request.get('/api/admin/search?q=a');
  expect(short.status()).toBe(400);
  const ok = await page.request.get('/api/admin/search?q=eva.e2e');
  expect(ok.status()).toBe(200);
  expect(ok.headers()['cache-control']).toContain('no-store');
  const body = (await ok.json()) as { orders: unknown[]; customers: unknown[]; events: unknown[] };
  expect(body.orders.length).toBeGreaterThan(0);
  expect(body.orders.length).toBeLessThanOrEqual(5);

  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await anon.request.get(`${new URL(page.url()).origin}/api/admin/search?q=eva.e2e`);
  expect(res.status()).toBe(403);
  await anon.close();
});

test('top bar shows the bell, the new menu and the user menu', async ({ page }) => {
  await page.goto('/admin');
  const bell = page.getByTestId('admin-bell');
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByRole('menu')).toContainText('Open to-dos');
  await page.keyboard.press('Escape');

  await page.getByTestId('admin-new-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Event' })).toHaveAttribute(
    'href',
    '/admin/events/new',
  );
  await page.keyboard.press('Escape');

  await page.getByTestId('admin-user-menu').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'My account' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await expect(menu).toContainText(/Version v\d/);
  await page.keyboard.press('Escape');
});

test('dashboard: overview with to-dos (or all clear) and the events table', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  const attention = page.getByTestId('dashboard-attention');
  await expect(attention).toBeVisible();
  await expect(attention.getByText('Needs attention')).toBeVisible();
  // Only open to-dos are listed; without any, an "All clear" note is shown.
  const todos = attention.locator('a[data-testid^="dashboard-todo-"]');
  if ((await todos.count()) === 0)
    await expect(page.getByTestId('dashboard-all-clear')).toBeVisible();
  else await expect(page.getByTestId('dashboard-all-clear')).toHaveCount(0);
  // The e2e admin is a super-admin: KPIs and the events table with the demo event.
  await expect(page.getByTestId('dashboard-kpi-revenue-today')).toBeVisible();
  const events = page.getByTestId('dashboard-events');
  await expect(events).toBeVisible();
  await expect(
    events.getByTestId('dashboard-event-row').filter({ hasText: 'Demo Concert' }).first(),
  ).toBeVisible();
  // The former button rows are gone (sidebar, "+ New" menu and palette cover them).
  await expect(page.locator('main').getByRole('link', { name: 'Venues & plans' })).toHaveCount(0);
  await expect(page.locator('main').getByRole('link', { name: 'Statistics' })).toHaveCount(0);
});

test('orders list: status tabs, toolbar "More filters" and reset', async ({ page }) => {
  await page.goto('/admin/orders');
  const tabs = page.getByRole('navigation', { name: 'Quick filters' });
  await expect(tabs.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/[?&]open=1/);
  await expect(tabs.getByRole('link', { name: 'Open' })).toHaveAttribute('aria-current', 'page');

  const toolbar = page.getByTestId('orders-toolbar');
  // Exactly one search field (the event select has no extra filter box any more).
  await expect(toolbar.getByRole('searchbox')).toHaveCount(1);
  const more = toolbar.getByTestId('list-more-filters');
  // The select inside the panel (the active-filter chip carries the same label).
  const channel = more.getByRole('combobox', { name: 'Sales channel' });
  // Filters apply by themselves once the form is hydrated (no apply button).
  await expect(toolbar.locator('form[data-auto-submit="ready"]')).toBeAttached();
  await expect(toolbar.getByRole('button', { name: 'Apply' })).toBeHidden();
  await more.locator('summary').click();
  await channel.selectOption('ONLINE');
  await expect(page).toHaveURL(/[?&]channel=ONLINE/);
  // The panel stays open while its filters apply.
  await expect(channel).toBeVisible();
  await expect(channel).toHaveValue('ONLINE');
  // The quick tab survives the toolbar submit.
  await expect(page).toHaveURL(/[?&]open=1/);
  await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('Sales channel');

  await page.getByTestId('list-reset-filters').click();
  await expect(page).not.toHaveURL(/channel=/);
  await expect(page).toHaveURL(/[?&]open=1/);
  await expect(page.getByTestId('list-reset-filters')).toHaveCount(0);
});

test('orders list: search and filters apply without a button, typing keeps every character', async ({
  page,
}) => {
  await page.goto('/admin/orders');
  const toolbar = page.getByTestId('orders-toolbar');
  await expect(toolbar.locator('form[data-auto-submit="ready"]')).toBeAttached();
  await expect(toolbar.getByRole('button', { name: 'Apply' })).toBeHidden();
  const search = toolbar.getByRole('searchbox');
  await search.click();
  // Pauses longer than the debounce: navigations land while the user keeps typing.
  await search.pressSequentially('eva', { delay: 450 });
  await search.pressSequentially('.e2e', { delay: 30 });
  await expect(page).toHaveURL(/[?&]q=eva\.e2e(&|$)/);
  await expect(search).toHaveValue('eva.e2e');
  await expect(search).toBeFocused();
  await expect(
    page.locator('table tbody tr', { hasText: 'eva.e2e@example.org' }).first(),
  ).toBeVisible();

  // A select applies on change and keeps the search.
  await toolbar.getByLabel('Status', { exact: true }).selectOption('PAID');
  await expect(page).toHaveURL(/[?&]status=PAID/);
  await expect(page).toHaveURL(/[?&]q=eva\.e2e/);
  await expect(search).toHaveValue('eva.e2e');

  // Removing the search chip clears the field.
  await page
    .getByRole('list', { name: 'Active filters' })
    .getByRole('link', { name: /eva\.e2e/ })
    .click();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(search).toHaveValue('');
});

test('order page: header actions, actions menu opens a dialog, activity tabs', async ({ page }) => {
  await page.goto('/admin/orders');
  const row = page.locator('table tbody tr', { hasText: 'eva.e2e@example.org' }).first();
  await expect(row).toBeVisible();
  await row.locator('a[href^="/admin/orders/"]').first().click();
  await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Orders');
  await expect(page.getByRole('link', { name: 'Customer view' })).toBeVisible();
  await expect(page.getByTestId('order-internal-note')).toBeVisible();

  const dialog = await openOrderAction(page, 'Change buyer e-mail');
  await expect(dialog.getByLabel('New e-mail address')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const activity = page.getByTestId('order-activity');
  await expect(activity.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(async () => {
    await activity.getByRole('tab', { name: /E-mails/ }).click();
    await expect(activity.getByRole('tab', { name: /E-mails/ })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 2_000 },
    );
  }).toPass({ timeout: 20_000 });
});

test('order page: a dialog from the actions menu closes with Escape and returns the focus', async ({
  page,
}) => {
  // The unpaid bank-transfer order placed by the shop project (not cancelled here).
  await page.goto('/admin/orders');
  const row = page
    .locator('table tbody tr', { hasText: 'eva.e2e@example.org' })
    .filter({ hasText: 'Awaiting transfer' })
    .first();
  await expect(row).toBeVisible();
  await row.locator('a[href^="/admin/orders/"]').first().click();
  await page.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}$/);

  const dialog = await openOrderAction(page, 'Cancel order');
  await expect(dialog).toHaveAttribute('data-testid', 'order-dialog-cancel');
  // The cancellation needs the explicit confirmation.
  const submit = dialog.getByRole('button', { name: 'Cancel order', exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Yes, cancel this order').check();
  await expect(submit).toBeEnabled();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // The menu item that opened the dialog is gone: the focus is back on the "Actions" trigger.
  await expect(page.getByTestId('order-actions')).toBeFocused();

  // No leftovers of the dialog (pointer-events / scroll lock): the page stays interactive.
  await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none');
  const activity = page.getByTestId('order-activity');
  await activity.getByRole('tab', { name: /E-mails/ }).click();
  await expect(activity.getByRole('tab', { name: /E-mails/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('user page: "Sign out everywhere" is offered for another admin without sessions', async ({
  page,
}) => {
  // Seeded by scripts/e2e/run.mjs; never signed in, so it has no active session.
  await page.goto('/admin/users');
  await page.locator('a[href^="/admin/users/"]', { hasText: 'E2E Staff' }).first().click();
  await page.waitForURL(/\/admin\/users\/[0-9a-f-]{36}$/);
  await page.getByTestId('user-actions').click();
  await page.getByTestId('user-sign-out-all').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('End all sessions of this user?');
  await dialog.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByText('All sessions of this user ended.')).toBeVisible();

  // Never for the own account: that has "Sign out on all other devices" on the account page.
  await page.goto('/admin/users');
  await page.locator('a[href^="/admin/users/"]', { hasText: 'E2E Admin' }).first().click();
  await page.waitForURL(/\/admin\/users\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'E2E Admin' })).toBeVisible();
  // The own account may have no menu at all (no 2FA): open it only when it is there.
  if ((await page.getByTestId('user-actions').count()) > 0) {
    await page.getByTestId('user-actions').click();
    await expect(page.getByRole('menu')).toBeVisible();
  }
  await expect(page.getByTestId('user-sign-out-all')).toHaveCount(0);
});

test('account page: "Sign out on all other devices" keeps this session', async ({
  page,
  browser,
}) => {
  // A second sign-in of the same admin (counts once against the sign-in rate limit).
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const otherPage = await other.newPage();
    await otherPage.goto('/admin/login');
    await otherPage.locator('input[type=email]').fill(ADMIN_EMAIL);
    await otherPage.locator('input[type=password]').fill(ADMIN_PASSWORD);
    await otherPage.locator('button[type=submit]').click();
    await otherPage.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });

    await page.goto('/admin/account');
    const section = page.locator('#sessions');
    await expect(section.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await section.getByTestId('account-sign-out-others').click();
    await expect(page.getByText('Signed out on all other devices.')).toBeVisible();

    // The other browser is signed out, this one still works.
    await otherPage.goto('/admin/account');
    await otherPage.waitForURL(/\/admin\/login/);
    await page.reload();
    await expect(page.locator('#sessions')).toBeVisible();
  } finally {
    await other.close();
  }
});

test('data retention lives in the settings', async ({ page }) => {
  await page.goto('/admin/settings/privacy');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Data protection & retention' }),
  ).toBeVisible();
  await expect(page.locator('#emailRetentionDays')).toBeVisible();
  await page.goto('/admin/customers');
  await expect(page.locator('#emailRetentionDays')).toHaveCount(0);
  await expect(page.getByTestId('customers-retention-hint').getByRole('link')).toHaveAttribute(
    'href',
    '/admin/settings/privacy',
  );
});
