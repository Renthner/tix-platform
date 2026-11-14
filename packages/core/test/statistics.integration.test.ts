/**
 * Sales statistics against real PostgreSQL: window / time-zone bucketing, KPI comparison with the
 * previous period, refunds by refund date, event / channel filters, customer breakdown.
 * Throw-away database; "now" is fixed so the fixtures are deterministic.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  customers,
  events,
  loadRootEnv,
  orderFees,
  orderItems,
  orders,
  priceCategories,
  refundItems,
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
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSalesStatisticsCache, getSalesStatistics } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;

const NOW = new Date('2026-06-15T12:00:00Z');
const BASE = {
  preset: '7d' as const,
  eventIds: [] as string[],
  channels: [] as never[],
  methods: [] as never[],
  now: NOW,
};

describe.skipIf(!adminUrl)('sales statistics (integration)', () => {
  const dbName = `tix_stats_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let event1: string;
  let event2: string;

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
    const db = handle.db;
    await seedReferenceData(db, () => {});

    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: `h-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [tax] = await db.select().from(taxRates).limit(1);
    const mkEvent = async (title: string, startsAt: Date) => {
      const [map] = await db
        .insert(seatMaps)
        .values({
          venueId: venue!.id,
          kind: 'EVENT',
          name: title,
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
      const [ev] = await db
        .insert(events)
        .values({
          venueId: venue!.id,
          seatMapId: map!.id,
          slug: `e-${randomUUID().slice(0, 6)}`,
          title,
          startsAt,
          timeZone: 'Europe/Berlin',
          currency: 'EUR',
          taxRateId: tax!.id,
          status: 'PUBLISHED',
        })
        .returning();
      const [cat1] = await db
        .insert(priceCategories)
        .values({ eventId: ev!.id, name: 'Cat 1', color: '#112233', basePrice: 2000 })
        .returning();
      const [cat2] = await db
        .insert(priceCategories)
        .values({ eventId: ev!.id, name: 'Cat 2', color: '#223344', basePrice: 1500 })
        .returning();
      const [normal] = await db
        .insert(ticketTypes)
        .values({ eventId: ev!.id, name: 'Normal' })
        .returning();
      const [reduced] = await db
        .insert(ticketTypes)
        .values({ eventId: ev!.id, name: 'Reduced' })
        .returning();
      return {
        id: ev!.id,
        sectionId: section!.id,
        cat1: cat1!.id,
        cat2: cat2!.id,
        normal: normal!.id,
        reduced: reduced!.id,
      };
    };
    const e1 = await mkEvent('Show 1', new Date('2026-06-20T18:00:00Z'));
    const e2 = await mkEvent('Show 2', new Date('2026-07-20T18:00:00Z'));
    event1 = e1.id;
    event2 = e2.id;

    const [c1, c2] = await db
      .insert(customers)
      .values([
        { email: `c1-${randomUUID().slice(0, 6)}@example.test`, firstName: 'C', lastName: 'One' },
        { email: `c2-${randomUUID().slice(0, 6)}@example.test`, firstName: 'C', lastName: 'Two' },
      ])
      .returning();

    interface Spec {
      customerId?: string;
      channel?: 'ONLINE' | 'BOX_OFFICE';
      method: 'PAYPAL' | 'BANK_TRANSFER' | 'CASH';
      paidAt: Date | null;
      currency?: string;
      fee?: number;
      items: {
        ev: typeof e1;
        cat: 'cat1' | 'cat2';
        tariff: 'normal' | 'reduced';
        price: number;
        status?: 'CONFIRMED' | 'REFUNDED' | 'PENDING' | 'CANCELLED';
        refundedAt?: Date;
      }[];
      refund?: { amount: number; at: Date; itemIndex: number };
    }
    const mkOrder = async (spec: Spec) => {
      const channel = spec.channel ?? 'ONLINE';
      const itemTotal = spec.items.reduce((s, i) => s + i.price, 0);
      const fee = spec.fee ?? 0;
      const total = itemTotal + fee;
      const paid = spec.paidAt !== null;
      const [order] = await db
        .insert(orders)
        .values({
          orderNumber: `S-${randomUUID().slice(0, 8)}`,
          channel,
          customerId: spec.customerId ?? null,
          email: spec.customerId ? 'buyer@example.test' : null,
          firstName: 'A',
          lastName: 'B',
          locale: 'en',
          currency: spec.currency ?? 'EUR',
          status: paid ? 'PAID' : 'AWAITING_PAYMENT',
          paymentMethod: spec.method,
          ...(paid
            ? {}
            : {
                paymentReference: `TIX-2026-${Math.floor(Math.random() * 900000 + 100000)}-7`,
                paymentDueAt: new Date(NOW.getTime() + 86_400_000),
              }),
          subtotalGross: itemTotal,
          feeTotal: fee,
          totalGross: total,
          totalNet: Math.round(total / 1.07),
          totalTax: total - Math.round(total / 1.07),
          amountPaid: paid ? total : 0,
          amountRefunded: spec.refund?.amount ?? 0,
          paidAt: spec.paidAt,
          createdAt: spec.paidAt ?? NOW,
        })
        .returning();
      const rows = await db
        .insert(orderItems)
        .values(
          spec.items.map((i) => ({
            orderId: order!.id,
            eventId: i.ev.id,
            kind: 'GENERAL_ADMISSION' as const,
            sectionId: i.ev.sectionId,
            priceCategoryId: i.ev[i.cat],
            ticketTypeId: i.ev[i.tariff],
            status: i.status ?? (paid ? ('CONFIRMED' as const) : ('PENDING' as const)),
            sectionLabel: 'Floor',
            categoryName: i.cat === 'cat1' ? 'Cat 1' : 'Cat 2',
            ticketTypeName: i.tariff === 'normal' ? 'Normal' : 'Reduced',
            unitPriceGross: i.price,
            priceGross: i.price,
            taxRateBasisPoints: 700,
            priceNet: Math.round(i.price / 1.07),
            taxAmount: i.price - Math.round(i.price / 1.07),
            refundedAt: i.refundedAt ?? null,
          })),
        )
        .returning();
      if (fee > 0) {
        await db.insert(orderFees).values({
          orderId: order!.id,
          scope: 'PER_ORDER',
          name: 'Service',
          quantity: 1,
          unitAmountGross: fee,
          totalGross: fee,
          taxRateBasisPoints: 1900,
          totalNet: fee - 16,
          totalTax: 16,
        });
      }
      if (spec.refund) {
        const [refund] = await db
          .insert(refunds)
          .values({
            orderId: order!.id,
            method: spec.method,
            kind: 'MANUAL',
            status: 'SUCCEEDED',
            amount: spec.refund.amount,
            currency: spec.currency ?? 'EUR',
            processedAt: spec.refund.at,
          })
          .returning();
        await db.insert(refundItems).values({
          refundId: refund!.id,
          orderItemId: rows[spec.refund.itemIndex]!.id,
          amount: spec.refund.amount,
        });
      }
    };

    // A: paid Wed 2026-06-10 12:00 Berlin, 2 tickets (one refunded on 06-12) + 1.00 fee.
    await mkOrder({
      customerId: c1!.id,
      method: 'PAYPAL',
      paidAt: new Date('2026-06-10T10:00:00Z'),
      fee: 100,
      items: [
        { ev: e1, cat: 'cat1', tariff: 'normal', price: 2000 },
        {
          ev: e1,
          cat: 'cat1',
          tariff: 'normal',
          price: 2000,
          status: 'REFUNDED',
          refundedAt: new Date('2026-06-12T09:00:00Z'),
        },
      ],
      refund: { amount: 2000, at: new Date('2026-06-12T09:00:00Z'), itemIndex: 1 },
    });
    // B: same customer again, event 2, reduced tariff, bank transfer.
    await mkOrder({
      customerId: c1!.id,
      method: 'BANK_TRANSFER',
      paidAt: new Date('2026-06-12T20:00:00Z'),
      items: [{ ev: e2, cat: 'cat2', tariff: 'reduced', price: 1500 }],
    });
    // C: 22:30 UTC = 00:30 Berlin on 2026-06-13 -> belongs to the next local day.
    await mkOrder({
      customerId: c2!.id,
      method: 'PAYPAL',
      paidAt: new Date('2026-06-12T22:30:00Z'),
      items: [{ ev: e1, cat: 'cat1', tariff: 'normal', price: 2000 }],
    });
    // D: box office cash sale without buyer.
    await mkOrder({
      channel: 'BOX_OFFICE',
      method: 'CASH',
      paidAt: new Date('2026-06-12T11:00:00Z'),
      items: [{ ev: e1, cat: 'cat1', tariff: 'normal', price: 2000 }],
    });
    // E: previous period (06-02 .. 06-08), first purchase of customer 2.
    await mkOrder({
      customerId: c2!.id,
      method: 'PAYPAL',
      paidAt: new Date('2026-06-05T10:00:00Z'),
      items: [{ ev: e1, cat: 'cat1', tariff: 'normal', price: 2000 }],
    });
    // F: unpaid reservation: never counted.
    await mkOrder({
      customerId: c1!.id,
      method: 'BANK_TRANSFER',
      paidAt: null,
      items: [{ ev: e1, cat: 'cat1', tariff: 'normal', price: 2000 }],
    });
    // G: other currency: only counted in the note.
    await mkOrder({
      customerId: c1!.id,
      method: 'PAYPAL',
      paidAt: new Date('2026-06-11T10:00:00Z'),
      currency: 'USD',
      items: [{ ev: e1, cat: 'cat1', tariff: 'normal', price: 2000 }],
    });
    // H: paid long before, only visible on the sales curve (and as "returning" proof).
    await mkOrder({
      customerId: c2!.id,
      method: 'PAYPAL',
      paidAt: new Date('2026-05-01T10:00:00Z'),
      items: [{ ev: e1, cat: 'cat1', tariff: 'normal', price: 2000 }],
    });
  });

  afterAll(async () => {
    clearSalesStatisticsCache();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('computes KPIs of the period and of the previous period', async () => {
    const stats = await getSalesStatistics(handle, BASE);
    expect(stats.range).toEqual({ from: '2026-06-09', to: '2026-06-15', days: 7 });
    expect(stats.previous).toEqual({ from: '2026-06-02', to: '2026-06-08' });
    expect(stats.interval).toBe('day');
    expect(stats.currency).toBe('EUR');
    expect(stats.timeZone).toBe('Europe/Berlin');
    // A (4100 incl. fee) + B 1500 + C 2000 + D 2000
    expect(stats.kpis.current).toMatchObject({
      orders: 4,
      tickets: 5,
      revenueGross: 9600,
      refunds: 2000,
      revenueNet: 7600,
      averageOrderValue: 2400,
      ticketsPerOrder: 1.25,
    });
    expect(stats.kpis.previous).toMatchObject({
      orders: 1,
      tickets: 1,
      revenueGross: 2000,
      refunds: 0,
    });
    expect(stats.otherCurrencyOrders).toBe(1);
  });

  it('buckets by local day, zero-fills gaps and attributes refunds to their date', async () => {
    const stats = await getSalesStatistics(handle, BASE);
    expect(stats.series.map((p) => p.bucket)).toEqual([
      '2026-06-09T00:00',
      '2026-06-10T00:00',
      '2026-06-11T00:00',
      '2026-06-12T00:00',
      '2026-06-13T00:00',
      '2026-06-14T00:00',
      '2026-06-15T00:00',
    ]);
    const by = Object.fromEntries(stats.series.map((p) => [p.bucket.slice(0, 10), p]));
    expect(by['2026-06-09']).toMatchObject({ orders: 0, revenue: 0 });
    expect(by['2026-06-10']).toMatchObject({ orders: 1, tickets: 2, revenue: 4100 });
    // B and D on the 12th; C (22:30 UTC) is already the 13th in Berlin.
    expect(by['2026-06-12']).toMatchObject({
      orders: 2,
      revenue: 3500,
      refunds: 2000,
      refundedTickets: 1,
    });
    expect(by['2026-06-13']).toMatchObject({ orders: 1, revenue: 2000 });
    // Customer 1: A is the first order (new), B returning; customer 2: C returning (E before).
    expect(stats.series.reduce((s, p) => s + p.newCustomerOrders, 0)).toBe(1);
    expect(stats.series.reduce((s, p) => s + p.returningCustomerOrders, 0)).toBe(2);
  });

  it('uses hourly buckets for a single day', async () => {
    const stats = await getSalesStatistics(handle, {
      ...BASE,
      preset: 'custom',
      from: '2026-06-10',
      to: '2026-06-10',
    });
    expect(stats.interval).toBe('hour');
    expect(stats.series).toHaveLength(24);
    expect(stats.series[12]).toMatchObject({
      bucket: '2026-06-10T12:00',
      orders: 1,
      revenue: 4100,
    });
  });

  it('breaks sales down by category, tariff, payment method, channel and hour', async () => {
    const stats = await getSalesStatistics(handle, BASE);
    expect(stats.byCategory).toEqual([
      { name: 'Cat 1', tickets: 4, revenue: 8000 },
      { name: 'Cat 2', tickets: 1, revenue: 1500 },
    ]);
    expect(stats.byTariff.map((t) => [t.name, t.tickets])).toEqual([
      ['Normal', 4],
      ['Reduced', 1],
    ]);
    expect(stats.bySection).toEqual([{ name: 'Floor', tickets: 5, revenue: 9500 }]);
    const method = Object.fromEntries(stats.byMethod.map((m) => [m.key, m]));
    expect(method.PAYPAL).toMatchObject({ orders: 2, revenue: 6100 });
    expect(method.BANK_TRANSFER).toMatchObject({ orders: 1, revenue: 1500 });
    expect(method.CASH).toMatchObject({ orders: 1, revenue: 2000 });
    const channel = Object.fromEntries(stats.byChannel.map((m) => [m.key, m]));
    expect(channel.ONLINE).toMatchObject({ orders: 3 });
    expect(channel.BOX_OFFICE).toMatchObject({ orders: 1 });
    // A: Wednesday 12:00 Berlin; C: Saturday 00:30 Berlin.
    expect(stats.heatmap).toContainEqual({ dow: 3, hour: 12, orders: 1, tickets: 2 });
    expect(stats.heatmap).toContainEqual({ dow: 6, hour: 0, orders: 1, tickets: 1 });
    expect(stats.heatmap.reduce((s, c) => s + c.orders, 0)).toBe(4);
  });

  it('filters by channel and payment method', async () => {
    const box = await getSalesStatistics(handle, { ...BASE, channels: ['BOX_OFFICE'] });
    expect(box.kpis.current).toMatchObject({
      orders: 1,
      tickets: 1,
      revenueGross: 2000,
      refunds: 0,
    });
    const bank = await getSalesStatistics(handle, { ...BASE, methods: ['BANK_TRANSFER'] });
    expect(bank.kpis.current).toMatchObject({ orders: 1, revenueGross: 1500 });
  });

  it('filters by event: only items and fees of that event, refunds of its tickets', async () => {
    const e1 = await getSalesStatistics(handle, { ...BASE, eventIds: [event1] });
    // A without the per-order fee: 4000, C 2000, D 2000; the refunded ticket belongs to event 1.
    expect(e1.kpis.current).toMatchObject({
      orders: 3,
      tickets: 4,
      revenueGross: 8000,
      refunds: 2000,
    });
    const e2 = await getSalesStatistics(handle, { ...BASE, eventIds: [event2] });
    expect(e2.kpis.current).toMatchObject({
      orders: 1,
      tickets: 1,
      revenueGross: 1500,
      refunds: 0,
    });
    expect(e2.otherCurrencyOrders).toBe(0);
  });

  it('describes customers and lead time', async () => {
    const stats = await getSalesStatistics(handle, BASE);
    // Customers 1 and 2 bought in the period; customer 2 had earlier orders; customer 1 bought
    // for two different events.
    expect(stats.customers).toEqual({ total: 2, returning: 1, multiEvent: 1 });
    // A, C, D bought 10 / 7 / 8 days before event 1 (2026-06-20); B 38 days before event 2.
    const lead = Object.fromEntries(stats.leadTime.map((l) => [l.bucket, l.tickets]));
    expect(lead['8-14']).toBe(3); // A (2 tickets, 10 days) + D (8 days)
    expect(lead['3-7']).toBe(1); // C: 7 days
    expect(lead['31-60']).toBe(1);
    expect(stats.averageLeadDays).toBeGreaterThan(0);
  });

  it('builds the sales curve per event over all time', async () => {
    const stats = await getSalesStatistics(handle, { ...BASE, eventIds: [event1] });
    expect(stats.salesCurve).toHaveLength(1);
    const curve = stats.salesCurve[0]!;
    expect(curve.title).toBe('Show 1');
    // A 2 + C + D + E + H (all time, USD order excluded) = 6
    expect(curve.total).toBe(6);
    expect(curve.points.every((p, i, a) => i === 0 || a[i - 1]!.daysBefore >= p.daysBefore)).toBe(
      true,
    );
    expect(Math.max(...curve.points.map((p) => p.daysBefore))).toBe(50);
  });

  it('buckets long ranges by ISO week and keeps the totals consistent', async () => {
    const stats = await getSalesStatistics(handle, {
      ...BASE,
      preset: 'custom',
      from: '2026-03-01',
      to: '2026-06-30',
    });
    expect(stats.interval).toBe('week');
    for (const point of stats.series) {
      const day = new Date(`${point.bucket.slice(0, 10)}T00:00:00Z`).getUTCDay();
      expect(day).toBe(1); // every bucket starts on a Monday
      expect(point.bucket.endsWith('T00:00')).toBe(true);
    }
    const labels = stats.series.map((p) => p.bucket);
    expect(new Set(labels).size).toBe(labels.length);
    expect(stats.series.reduce((s, p) => s + p.revenue, 0)).toBe(stats.kpis.current.revenueGross);
    expect(stats.series.reduce((s, p) => s + p.tickets, 0)).toBe(stats.kpis.current.tickets);
    expect(stats.series.reduce((s, p) => s + p.refunds, 0)).toBe(stats.kpis.current.refunds);
  });

  it('caches results per filter', async () => {
    clearSalesStatisticsCache();
    const { now: _now, ...rest } = BASE;
    const query = { ...rest, preset: 'year' as const };
    const first = await getSalesStatistics(handle, query);
    const second = await getSalesStatistics(handle, query);
    expect(second).toBe(first);
  });
});
