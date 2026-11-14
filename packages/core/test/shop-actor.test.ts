import { describe, expect, it } from 'vitest';
import {
  bypassesQueue,
  canAccessEventShop,
  computeSaleState,
  resolveShopActor,
  shopSaleState,
  type EventRow,
} from '../src';

const HOUR = 3_600_000;
const NOW = new Date('2026-06-15T12:00:00Z');

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    status: 'PUBLISHED',
    startsAt: new Date(NOW.getTime() + 48 * HOUR),
    saleEndsAt: null,
    presaleStartsAt: null,
    publicSaleStartsAt: null,
    salesPaused: false,
    ...overrides,
  } as EventRow;
}

const superAdmin = { superAdmin: true };

describe('shop sale state per actor', () => {
  it('keeps customers exactly on computeSaleState', () => {
    const paused = event({ salesPaused: true });
    expect(shopSaleState(paused, null, NOW)).toBe(computeSaleState(paused, NOW));
    expect(shopSaleState(event({ status: 'DRAFT' }), undefined, NOW)).toBe('NOT_PUBLISHED');
  });

  it('never gives a non super-admin actor any privilege', () => {
    const draft = event({ status: 'DRAFT' });
    expect(shopSaleState(draft, { superAdmin: false }, NOW)).toBe('NOT_PUBLISHED');
    expect(canAccessEventShop(draft, { superAdmin: false })).toBe(false);
    expect(canAccessEventShop(draft, null)).toBe(false);
    expect(bypassesQueue({ superAdmin: false })).toBe(false);
    expect(bypassesQueue(null)).toBe(false);
  });

  it('lets a super-admin buy drafts and bypass presale / not started / paused / sale end', () => {
    expect(canAccessEventShop(event({ status: 'DRAFT' }), superAdmin)).toBe(true);
    expect(shopSaleState(event({ status: 'DRAFT' }), superAdmin, NOW)).toBe('ON_SALE');
    const future = new Date(NOW.getTime() + 5 * HOUR);
    expect(shopSaleState(event({ publicSaleStartsAt: future }), superAdmin, NOW)).toBe('ON_SALE');
    expect(
      shopSaleState(event({ presaleStartsAt: NOW, publicSaleStartsAt: future }), superAdmin, NOW),
    ).toBe('ON_SALE');
    expect(shopSaleState(event({ salesPaused: true }), superAdmin, NOW)).toBe('ON_SALE');
    // Online sale window closed but the event has not started yet.
    expect(
      shopSaleState(event({ saleEndsAt: new Date(NOW.getTime() - HOUR) }), superAdmin, NOW),
    ).toBe('ON_SALE');
    expect(shopSaleState(event({ status: 'POSTPONED' }), superAdmin, NOW)).toBe('ON_SALE');
  });

  it('stops a super-admin once the event started and for cancelled / archived events', () => {
    const started = event({ startsAt: new Date(NOW.getTime() - HOUR) });
    expect(shopSaleState(started, superAdmin, NOW)).toBe('ENDED');
    expect(shopSaleState(event({ status: 'CANCELLED' }), superAdmin, NOW)).toBe('CANCELLED');
    expect(shopSaleState(event({ status: 'ARCHIVED' }), superAdmin, NOW)).toBe('NOT_PUBLISHED');
  });

  it('is never stricter than the customer rule (ON_SALE for customers stays ON_SALE)', () => {
    const times = [-48, -3, -1, 0, 1, 3, 24, 47, 49, 72].map(
      (h) => new Date(NOW.getTime() + h * HOUR),
    );
    const statuses = ['DRAFT', 'PUBLISHED', 'POSTPONED', 'CANCELLED', 'ARCHIVED'] as const;
    let onSale = 0;
    for (const status of statuses)
      for (const paused of [false, true])
        for (const startsAt of times)
          for (const saleEndsAt of [null, ...times])
            for (const presaleStartsAt of [null, ...times])
              for (const publicSaleStartsAt of [null, ...times]) {
                const e = event({
                  status,
                  salesPaused: paused,
                  startsAt,
                  saleEndsAt,
                  presaleStartsAt,
                  publicSaleStartsAt,
                });
                const customer = computeSaleState(e, NOW);
                const admin = shopSaleState(e, superAdmin, NOW);
                if (customer === 'ON_SALE') {
                  onSale += 1;
                  expect(admin).toBe('ON_SALE');
                }
                // Never opens what is closed for everybody.
                if (status === 'CANCELLED') expect(admin).toBe('CANCELLED');
                if (status === 'ARCHIVED') expect(admin).toBe('NOT_PUBLISHED');
                // The hard stop: nothing is sold once the event started and the customer rule agrees.
                if (
                  status !== 'DRAFT' &&
                  NOW >= startsAt &&
                  (saleEndsAt ?? startsAt) <= startsAt &&
                  customer !== 'ON_SALE'
                )
                  expect(admin).not.toBe('ON_SALE');
              }
    expect(onSale).toBeGreaterThan(100);
  });

  it('keeps selling after the event start only while customers may too', () => {
    const e = event({
      startsAt: new Date(NOW.getTime() - HOUR),
      saleEndsAt: new Date(NOW.getTime() + HOUR),
    });
    expect(computeSaleState(e, NOW)).toBe('ON_SALE');
    expect(shopSaleState(e, superAdmin, NOW)).toBe('ON_SALE');
  });

  it('only bypasses the waiting room while the test switch is off', () => {
    expect(bypassesQueue(superAdmin)).toBe(true);
    expect(bypassesQueue({ superAdmin: true, queueTest: false })).toBe(true);
    expect(bypassesQueue({ superAdmin: true, queueTest: true })).toBe(false);
  });
  describe('resolveShopActor (admin session → shop privileges)', () => {
    const session = (roles: string[], twoFactorSetupRequired = false) => ({
      roles,
      twoFactorSetupRequired,
    });

    it('gives nothing to anonymous visitors and to every role except SUPER_ADMIN', () => {
      expect(resolveShopActor(null, false)).toBeNull();
      for (const role of ['EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF', 'BOX_OFFICE']) {
        expect(resolveShopActor(session([role]), false)).toBeNull();
        expect(resolveShopActor(session([role, 'EVENT_MANAGER']), true)).toBeNull();
      }
    });

    it('requires finished two-factor set-up, like the admin API', () => {
      expect(resolveShopActor(session(['SUPER_ADMIN'], true), false)).toBeNull();
    });

    it('returns the actor for a SUPER_ADMIN, with the waiting-room test switch from the cookie', () => {
      expect(resolveShopActor(session(['SUPER_ADMIN']), false)).toEqual({
        superAdmin: true,
        queueTest: false,
      });
      expect(resolveShopActor(session(['EVENT_MANAGER', 'SUPER_ADMIN']), true)).toEqual({
        superAdmin: true,
        queueTest: true,
      });
    });
  });
});
