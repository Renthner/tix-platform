/**
 * Cash-up report against real PostgreSQL (throw-away database): per seller / payment method
 * aggregation of counter sales, exclusion of online and test orders, date range and event filter.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  createDb,
  customers,
  events,
  loadRootEnv,
  orderItems,
  orders,
  priceCategories,
  refunds,
  seatMapSections,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreContext, getCashUpReport, listCashUpSellers, type CoreContext } from '../src';
import { addToTotals, summarise, type CashUpLine, type CashUpTotals } from '../src/reports/cash-up';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

const line = (over: Partial<CashUpLine> = {}): CashUpLine => ({
  sellerUserId: 'u1',
  sellerName: 'Anna',
  method: 'CASH',
  currency: 'EUR',
  orders: 0,
  tickets: 0,
  sales: 0,
  gross: 0,
  refunded: 0,
  refundedOrders: 0,
  refundedOrdersGross: 0,
  refundsOpen: 0,
  cancelledOrders: 0,
  cancelledGross: 0,
  ...over,
});

const zero: CashUpTotals = {
  orders: 0,
  tickets: 0,
  sales: 0,
  gross: 0,
  refunded: 0,
  net: 0,
  refundedOrders: 0,
  refundedOrdersGross: 0,
  refundsOpen: 0,
  cancelledOrders: 0,
  cancelledGross: 0,
};

describe('cash-up totals', () => {
  it('adds lines and derives net = gross - refunded', () => {
    const total = addToTotals(
      addToTotals(zero, line({ orders: 2, tickets: 3, gross: 5000, refunded: 1000 })),
      line({ orders: 1, tickets: 1, gross: 2000, cancelledOrders: 1, cancelledGross: 900 }),
    );
    expect(total).toMatchObject({ orders: 3, tickets: 4, gross: 7000, refunded: 1000, net: 6000 });
    expect(total.cancelledOrders).toBe(1);
  });

  it('groups lines by key', () => {
    const map = summarise(
      [
        line({ method: 'CASH', gross: 1000 }),
        line({ method: 'CARD', gross: 500 }),
        line({ method: 'CASH', gross: 250 }),
      ],
      (l) => l.method,
    );
    expect(map.get('CASH')?.gross).toBe(1250);
    expect(map.get('CARD')?.gross).toBe(500);
  });
});

describe.skipIf(!adminUrl || !redisUrl)('cash-up report (integration)', () => {
  const dbName = `tix_cashup_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let eventId: string;
  let otherEventId: string;
  let anna: string;
  let ben: string;
  const day = new Date('2026-06-10T12:00:00Z');

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 5 });
    await seedReferenceData(handle.db, () => {});
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
    });
    const db = handle.db;
    const mkUser = async (name: string) => {
      const [u] = await db
        .insert(adminUsers)
        .values({
          email: `${name}-${randomUUID().slice(0, 6)}@example.org`,
          displayName: name,
          passwordHash: 'x',
          roles: ['DOOR_STAFF'],
        })
        .returning();
      return u!.id;
    };
    anna = await mkUser('Anna');
    ben = await mkUser('Ben');
    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: `h-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [tax] = await db.select().from(taxRates).limit(1);
    const mkEvent = async (title: string) => {
      const [map] = await db
        .insert(seatMaps)
        .values({
          venueId: venue!.id,
          kind: 'EVENT',
          name: 'Hall',
          canvasWidth: 100,
          canvasHeight: 100,
        })
        .returning();
      const [section] = await db
        .insert(seatMapSections)
        .values({
          seatMapId: map!.id,
          type: 'STANDING',
          name: 'Floor',
          ticketLabel: 'Floor',
          capacity: 100,
          geometry: { type: 'rect', x: 0, y: 0, width: 50, height: 50, rotation: 0 },
        })
        .returning();
      const [e] = await db
        .insert(events)
        .values({
          venueId: venue!.id,
          seatMapId: map!.id,
          slug: `ev-${randomUUID().slice(0, 6)}`,
          title,
          startsAt: new Date('2026-07-01T18:00:00Z'),
          timeZone: 'Europe/Berlin',
          currency: 'EUR',
          taxRateId: tax!.id,
          status: 'PUBLISHED',
        })
        .returning();
      const [category] = await db
        .insert(priceCategories)
        .values({ eventId: e!.id, name: 'Cat', color: '#112233', basePrice: 2000 })
        .returning();
      const [tariff] = await db
        .insert(ticketTypes)
        .values({ eventId: e!.id, name: 'Normal' })
        .returning();
      return { id: e!.id, categoryId: category!.id, tariffId: tariff!.id, sectionId: section!.id };
    };
    const ev = await mkEvent('Show');
    const ev2 = await mkEvent('Other');
    eventId = ev.id;
    otherEventId = ev2.id;
    const order = async (
      who: string | null,
      over: Partial<typeof orders.$inferInsert>,
      tickets: number,
      e = ev,
    ) => {
      const total = over.totalGross ?? 2000;
      const [o] = await db
        .insert(orders)
        .values({
          channel: 'BOX_OFFICE',
          firstName: 'A',
          lastName: 'B',
          locale: 'en',
          currency: 'EUR',
          orderNumber: `C-${randomUUID().slice(0, 8)}`,
          status: 'PAID',
          paymentMethod: 'CASH',
          subtotalGross: total,
          totalGross: total,
          totalNet: total,
          totalTax: 0,
          amountPaid: total,
          createdByUserId: who,
          createdAt: day,
          paidAt: day,
          cancelledAt: day,
          ...over,
        })
        .returning();
      for (let i = 0; i < tickets; i += 1) {
        await db.insert(orderItems).values({
          orderId: o!.id,
          eventId: e.id,
          kind: 'GENERAL_ADMISSION',
          sectionId: e.sectionId,
          priceCategoryId: e.categoryId,
          ticketTypeId: e.tariffId,
          status: 'CONFIRMED',
          sectionLabel: 'Floor',
          categoryName: 'Cat',
          ticketTypeName: 'Normal',
          unitPriceGross: total / tickets,
          priceGross: total / tickets,
          taxRateBasisPoints: 0,
          priceNet: total / tickets,
          taxAmount: 0,
        });
      }
      return o!.id;
    };
    const refund = (
      orderId: string,
      amount: number,
      over: Partial<typeof refunds.$inferInsert> = {},
    ) =>
      db.insert(refunds).values({
        orderId,
        method: 'CASH',
        kind: 'MANUAL',
        status: 'SUCCEEDED',
        amount,
        currency: 'EUR',
        processedAt: day,
        createdAt: day,
        ...over,
      });
    await order(anna, { totalGross: 4000 }, 2);
    await order(anna, { paymentMethod: 'CARD', totalGross: 2000 }, 1);
    const partly = await order(
      ben,
      { totalGross: 2000, amountRefunded: 500, status: 'PARTIALLY_REFUNDED' },
      1,
    );
    // Paid back on the day + a second refund of the same (partly refunded) order still open.
    await refund(partly, 500);
    await refund(partly, 300, { status: 'PENDING', processedAt: null });
    await order(ben, { paymentMethod: 'COMPLIMENTARY', totalGross: 0, amountPaid: 0 }, 1);
    await order(ben, { status: 'CANCELLED', amountPaid: 0, totalGross: 2000 }, 1);
    const refundedOrder = await order(
      ben,
      { status: 'REFUNDED', totalGross: 2000, amountRefunded: 0 },
      1,
    );
    await refund(refundedOrder, 2000, { status: 'PENDING', processedAt: null });
    // Sold two days earlier, paid back on the report day: counts as refunded on the report day
    // (by the refund's own date), its sale does not.
    const older = await order(
      anna,
      {
        totalGross: 1500,
        amountRefunded: 700,
        status: 'PARTIALLY_REFUNDED',
        createdAt: new Date('2026-06-08T12:00:00Z'),
      },
      1,
    );
    await refund(older, 700);
    // Paid back on another day: not in the report day.
    await refund(older, 100, { processedAt: new Date('2026-06-12T12:00:00Z') });
    // Another currency is never added to the EUR figures.
    await order(anna, { currency: 'CHF', totalGross: 1500 }, 1, ev2);
    // Excluded: online order, test order, other day; other event (only for the event filter).
    const [customer] = await db
      .insert(customers)
      .values({ email: 'a@example.org', firstName: 'A', lastName: 'B' })
      .returning();
    await order(
      null,
      {
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email: 'a@example.org',
        customerId: customer!.id,
      },
      1,
    );
    await order(anna, { isTest: true }, 1);
    await order(anna, { createdAt: new Date('2026-06-12T12:00:00Z') }, 1);
    await order(anna, { totalGross: 1000 }, 1, ev2);
  });

  afterAll(async () => {
    await handle?.close();
    await redis?.quit();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  const range = { from: '2026-06-10', to: '2026-06-10', timeZone: 'Europe/Berlin' };

  const total = (report: Awaited<ReturnType<typeof getCashUpReport>>, currency = 'EUR') =>
    report.totals.find((t) => t.currency === currency)?.totals;

  it('aggregates per method and seller, ignoring online / test orders', async () => {
    const report = await getCashUpReport(ctx, { ...range, eventId });
    const cash = report.byMethod.find((m) => m.method === 'CASH')!.totals;
    // Sales: Anna 4000 + Ben 2000 (sold orders). Received: additionally the 2000 of the order
    // that was refunded later (the money came in on the day).
    expect(cash.sales).toBe(6000);
    expect(cash.gross).toBe(8000);
    // Refunds paid back on the day, by their own date: Ben 500 + Anna 700 (older order).
    expect(cash.refunded).toBe(1200);
    expect(cash.net).toBe(6800);
    expect(cash.orders).toBe(2);
    expect(cash.tickets).toBe(3);
    expect(cash.cancelledOrders).toBe(1);
    expect(cash.refundedOrders).toBe(1);
    expect(cash.refundedOrdersGross).toBe(2000);
    // Open: 2000 (refunded order) + 300 (still open on the partly refunded order).
    expect(cash.refundsOpen).toBe(2300);
    expect(report.byMethod.find((m) => m.method === 'CARD')!.totals.gross).toBe(2000);
    expect(report.byMethod.find((m) => m.method === 'COMPLIMENTARY')!.totals.tickets).toBe(1);
    expect(report.byMethod.some((m) => m.method === 'PAYPAL')).toBe(false);
    expect(report.totals).toHaveLength(1);
    expect(total(report)!.gross).toBe(10000);
    expect(total(report)!.sales).toBe(8000);
    expect(report.bySeller.map((s) => s.sellerName).sort()).toEqual(['Anna', 'Ben']);
  });

  it('restricts to one seller (door staff see only their own sales)', async () => {
    const report = await getCashUpReport(ctx, { ...range, eventId, sellerUserId: anna });
    expect(total(report)!.gross).toBe(6000);
    expect(total(report)!.refunded).toBe(700);
    expect(report.bySeller).toHaveLength(1);
    expect(report.bySeller[0]!.sellerName).toBe('Anna');
    expect(ben).not.toBe(anna);
  });

  it('honours the event filter and the date range; currencies are never mixed', async () => {
    const other = await getCashUpReport(ctx, { ...range, eventId: otherEventId });
    expect(total(other)!.gross).toBe(1000);
    expect(total(other, 'CHF')!.gross).toBe(1500);
    expect(other.byMethod.map((m) => m.currency).sort()).toEqual(['CHF', 'EUR']);
    const all = await getCashUpReport(ctx, { ...range });
    expect(total(all)!.gross).toBe(11000);
    expect(total(all, 'CHF')!.gross).toBe(1500);
    const later = await getCashUpReport(ctx, { ...range, from: '2026-06-12', to: '2026-06-12' });
    expect(total(later)!.gross).toBe(2000);
    // The 100 paid back on the 12th of an order sold on the 8th.
    expect(total(later)!.refunded).toBe(100);
    const empty = await getCashUpReport(ctx, { ...range, from: '2026-06-20', to: '2026-06-21' });
    expect(empty.lines).toHaveLength(0);
  });

  it('rejects an invalid range and lists the sellers', async () => {
    await expect(
      getCashUpReport(ctx, { ...range, from: '2026-06-11', to: '2026-06-10' }),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    expect((await listCashUpSellers(ctx)).map((s) => s.name)).toEqual(['Anna', 'Ben']);
  });
});
