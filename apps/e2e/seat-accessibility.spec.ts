import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openEvent } from './helpers';

// Accessible seat selection: keyboard-only use of the plan, the list alternative, axe with the
// focus inside the chart. Runs in the anonymous `shop` project (English UI).

const SELECTION_ITEM = /Row \S+ · Seat \S+/;

/** Presses Tab until a seat of the plan has focus (the zoom buttons come first). */
async function tabIntoChart(page: Page): Promise<void> {
  await page
    .locator('main')
    .first()
    .click({ position: { x: 1, y: 1 }, force: true });
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const onSeat = await page.evaluate(() => document.activeElement?.hasAttribute('data-seat-nav'));
    if (onSeat) return;
  }
  throw new Error('Tab never reached a seat of the plan');
}

const activeSeat = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      id: el?.getAttribute('data-seat-nav') ?? null,
      selectable: el?.hasAttribute('data-seat') ?? false,
      label: el?.getAttribute('aria-label') ?? '',
      pressed: el?.getAttribute('aria-pressed') ?? null,
    };
  });

/** Moves right along the row until the focused seat can be selected (some seats are blocked). */
async function arrowToSelectableSeat(page: Page): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if ((await activeSeat(page)).selectable) return;
    await page.keyboard.press('ArrowRight');
  }
  throw new Error('no selectable seat found by arrow keys');
}

test.describe('accessible seat selection', () => {
  test('keyboard only: Tab into the plan, arrows, Enter selects, Space releases, Escape leaves', async ({
    page,
  }) => {
    await openEvent(page);
    await tabIntoChart(page);

    // Exactly one roving tab stop.
    expect(await page.locator('[data-seat-nav][tabindex="0"]').count()).toBe(1);

    // Accessible name: place, category + price, state.
    const first = await activeSeat(page);
    expect(first.label).toMatch(/Row \S+, Seat \S+/);
    expect(first.label).toMatch(/(available|not available|selected)$/);
    expect(first.label).toMatch(/\d/); // price

    // Visible focus ring (dark ring on the light sheet).
    const ring = await page.evaluate(() => {
      const el = document.activeElement?.querySelector('.tix-seat-focus-ring');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { display: cs.display, stroke: cs.stroke };
    });
    expect(ring?.display).not.toBe('none');
    expect(ring?.stroke).toBe('rgb(17, 24, 39)');

    // Arrow keys move the focus (and the tab stop) to a neighbouring seat.
    await page.keyboard.press('ArrowRight');
    const moved = await activeSeat(page);
    expect(moved.id).not.toBe(first.id);
    expect(await page.locator('[data-seat-nav][tabindex="0"]').count()).toBe(1);
    await page.keyboard.press('ArrowLeft');
    expect((await activeSeat(page)).id).toBe(first.id);
    await page.keyboard.press('ArrowDown');
    const below = await activeSeat(page);
    expect(below.id).not.toBe(first.id);
    await page.keyboard.press('ArrowUp');
    expect((await activeSeat(page)).id).toBe(first.id);
    await page.keyboard.press('End');
    const end = (await activeSeat(page)).id;
    expect(end).not.toBe(first.id);
    await page.keyboard.press('Home');
    expect((await activeSeat(page)).id).toBe(first.id);

    // Enter selects: the seat lands in "Your selection" and is announced.
    await arrowToSelectableSeat(page);
    const target = await activeSeat(page);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listitem').filter({ hasText: SELECTION_ITEM })).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: /selected\./ })).toBeAttached();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed'))).toBe(
      'true',
    );
    expect((await activeSeat(page)).id).toBe(target.id);

    // Space releases it again.
    await page.keyboard.press(' ');
    await expect(page.getByRole('listitem').filter({ hasText: SELECTION_ITEM })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /released\./ })).toBeAttached();

    // Escape leaves the plan (focus goes to the list toggle before it).
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('seat-view-toggle')).toBeFocused();
  });

  test('arrow keys cross block boundaries; Ctrl+Home / Ctrl+End; standing area is a control', async ({
    page,
  }) => {
    await openEvent(page);
    await tabIntoChart(page);
    const sectionOf = async () => ((await activeSeat(page)).label.split(', ')[0] ?? '').trim();

    // Ctrl+Home / Ctrl+End: first and last seat of the whole plan (different blocks).
    await page.keyboard.press('Control+End');
    const lastSection = await sectionOf();
    const lastId = (await activeSeat(page)).id;
    await page.keyboard.press('Control+Home');
    const firstSection = await sectionOf();
    const firstId = (await activeSeat(page)).id;
    expect(lastId).not.toBe(firstId);
    expect(lastSection).not.toBe(firstSection);

    // Only arrow keys: keep going down until the block changes.
    let crossed = false;
    for (let i = 0; i < 40 && !crossed; i += 1) {
      await page.keyboard.press('ArrowDown');
      crossed = (await sectionOf()) !== firstSection;
    }
    expect(crossed).toBe(true);
    const second = await sectionOf();
    expect(second).not.toBe(firstSection);
    // ...and back up again with the arrow key.
    for (let i = 0; i < 40 && (await sectionOf()) !== firstSection; i += 1) {
      await page.keyboard.press('ArrowUp');
    }
    expect(await sectionOf()).toBe(firstSection);

    // Select a seat in the second block using only the keyboard.
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 40 && (await sectionOf()) === firstSection; i += 1) {
      await page.keyboard.press('ArrowDown');
    }
    expect(await sectionOf()).toBe(second);
    await arrowToSelectableSeat(page);
    expect(await sectionOf()).toBe(second);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listitem').filter({ hasText: SELECTION_ITEM })).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: /selected\./ })).toBeAttached();
    await page.keyboard.press(' ');
    await expect(page.getByRole('listitem').filter({ hasText: SELECTION_ITEM })).toHaveCount(0);

    // The standing area is reachable (Page Down) as a button and opens its quantity panel.
    for (let i = 0; i < 6; i += 1) {
      if ((await activeSeat(page)).label.startsWith('Standing area')) break;
      await page.keyboard.press('PageDown');
    }
    const standing = await page.evaluate(() => {
      const el = document.activeElement;
      return { id: el?.getAttribute('data-seat-nav') ?? '', role: el?.getAttribute('role') };
    });
    expect(standing.id.startsWith('ga:')).toBe(true);
    expect(standing.role).toBe('button');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Standing tickets')).toBeVisible();
  });

  test('axe: no serious violations with the keyboard focus inside the chart', async ({ page }) => {
    await openEvent(page);
    await tabIntoChart(page);
    await page.keyboard.press('ArrowRight');
    const result = await new AxeBuilder({ page })
      .include('[data-realtime]')
      .include('aside')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
    expect(serious).toEqual([]);
  });

  test('list view: filter, select a seat, stays in sync with the plan', async ({ page }) => {
    await openEvent(page);
    await page.getByTestId('seat-view-toggle').click();
    await expect(page.getByTestId('seat-view-toggle')).toHaveText(/Show plan/);
    // The plan is hidden from assistive technology while the list is shown.
    await expect(page.locator('[data-seat-nav]').first()).toBeHidden();

    // Category filter narrows the list; "all" shows more.
    const sections = page.getByTestId('seat-list-section');
    await expect(sections.first()).toBeVisible();
    await sections.first().locator('summary').click();
    const seatButtons = page.locator('[data-seat-list]');
    await expect(seatButtons.first()).toBeVisible();
    const all = await seatButtons.count();
    const options = await page
      .getByLabel('Category', { exact: true })
      .locator('option')
      .allTextContents();
    expect(options.length).toBeGreaterThan(2);
    await page
      .getByRole('region', { name: 'Seat list' })
      .getByLabel('Category', { exact: true })
      .selectOption({ index: 1 });
    await expect.poll(async () => seatButtons.count()).toBeLessThanOrEqual(all);
    await page
      .getByRole('region', { name: 'Seat list' })
      .getByLabel('Category', { exact: true })
      .selectOption({ index: 0 });

    // Wheelchair / companion seats are findable.
    const special = page.getByLabel('Wheelchair and companion seats only');
    if (await special.count()) {
      await special.check();
      await expect(page.locator('[data-seat-list]').first()).toHaveAttribute(
        'aria-label',
        /Wheelchair space|Companion seat/,
      );
      await special.uncheck();
    }

    // Select a seat through the list.
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    const seat = page.locator('[data-seat-list]').first();
    const id = await seat.getAttribute('data-seat-list');
    await expect(seat).toHaveAttribute('aria-label', /available$/);
    await seat.click();
    await expect(page.getByRole('listitem').filter({ hasText: SELECTION_ITEM })).toHaveCount(1);
    await expect(seat).toHaveAttribute('aria-pressed', 'true');

    // Back on the plan the same seat is selected.
    await page.getByTestId('seat-view-toggle').click();
    await expect(page.locator(`g[data-seat-nav="${id}"]`)).toHaveAttribute('aria-pressed', 'true');

    // And releasing it on the plan shows in the list.
    await page.getByTestId('seat-view-toggle').click();
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await page.locator(`[data-seat-list="${id}"]`).click();
    await expect(page.getByRole('listitem').filter({ hasText: SELECTION_ITEM })).toHaveCount(0);
  });
});
