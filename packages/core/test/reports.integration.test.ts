/**
 * Door reports against real PostgreSQL (throw-away database): the guest list and the seating
 * occupancy exclude test, cancelled and replaced data and report holders / check-in state.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  customers,
  events,
  loadRootEnv,
  orderItems,
  orders,
  priceCategories,
  seatMapRows,
  seatMapSections,
  seatMaps,
  seats,
  taxRates,
  tickets,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  ensureOrderTickets,
  loadGuestList,
  loadOccupancy,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('door reports (integration)', () => {
  const dbName = `tix_reports_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let eventId: string;
  let mapId: string;
  let seatedId: string;
  let floorId: string;
  let rowId: string;
  let categoryId: string;
  let typeId: string;
  const seatIds: string[] = [];

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
    handle = createDb({ connectionString: url.toString(), poolMax: 10 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${uuid().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'http://localhost:8080',
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
    });
    const { db } = handle;
    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
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
    mapId = map!.id;
    const geometry = { type: 'rect' as const, x: 0, y: 0, width: 50, height: 50, rotation: 0 };
    const [seated] = await db
      .insert(seatMapSections)
      .values({ seatMapId: mapId, type: 'SEATED', geometry, name: 'Stalls', ticketLabel: 'Stalls' })
      .returning();
    seatedId = seated!.id;
    const [floor] = await db
      .insert(seatMapSections)
      .values({
        seatMapId: mapId,
        type: 'STANDING',
        capacity: 50,
        geometry,
        name: 'Floor',
        ticketLabel: 'Floor',
        sortOrder: 1,
      })
      .returning();
    floorId = floor!.id;
    const [row] = await db
      .insert(seatMapRows)
      .values({
        seatMapId: mapId,
        sectionId: seatedId,
        label: 'A',
        geometry: { type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 } as never,
      })
      .returning();
    rowId = row!.id;
    const created = await db
      .insert(seats)
      .values(
        [1, 2, 3, 4, 5, 6].map((n) => ({
          seatMapId: mapId,
          sectionId: seatedId,
          rowId,
          label: String(n),
          position: n,
          x: n,
          y: 0,
          blockReason: n === 6 ? ('PRESS' as const) : null,
          blockedAt: n === 6 ? new Date() : null,
        })),
      )
      .returning();
    created.sort((a, b) => a.position! - b.position!);
    seatIds.push(...created.map((s) => s.id));
    const [rate] = await db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const [ev] = await db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: mapId,
        slug: `ev-${uuid().slice(0, 8)}`,
        title: 'Show',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: rate!.id,
      })
      .returning();
    eventId = ev!.id;
    const [cat] = await db
      .insert(priceCategories)
      .values({ eventId, name: 'Cat 1', color: '#336699', basePrice: 2000 })
      .returning();
    categoryId = cat!.id;
    const [type] = await db
      .insert(ticketTypes)
      .values({ eventId, name: 'Normal', isDefault: true })
      .returning();
    typeId = type!.id;
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) await redis.quit();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function order(opts: {
    seatId?: string;
    sectionId?: string;
    first: string;
    last: string;
    isTest?: boolean;
    status?: 'PAID' | 'AWAITING_PAYMENT' | 'CANCELLED';
    itemStatus?: 'CONFIRMED' | 'PENDING' | 'CANCELLED';
    attendeeName?: string;
  }) {
    const email = `b-${uuid().slice(0, 8)}@example.org`;
    const [customer] = await handle.db
      .insert(customers)
      .values({ email, firstName: opts.first, lastName: opts.last })
      .returning();
    const [o] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `T-${uuid().slice(0, 8).toUpperCase()}`,
        customerId: customer!.id,
        status: opts.status ?? 'PAID',
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email,
        firstName: opts.first,
        lastName: opts.last,
        billingAddress: { street: 'Weg 1', postalCode: '12345', city: 'Stadt', country: 'DE' },
        locale: 'en',
        currency: 'EUR',
        subtotalGross: 2000,
        feeTotal: 0,
        totalGross: 2000,
        totalNet: 1680,
        totalTax: 320,
        amountPaid: (opts.status ?? 'PAID') === 'PAID' ? 2000 : 0,
        paidAt: (opts.status ?? 'PAID') === 'PAID' ? new Date() : null,
        cancelledAt: opts.status === 'CANCELLED' ? new Date() : null,
        isTest: opts.isTest ?? false,
        termsAcceptedAt: new Date(),
        paymentReference:
          opts.status === 'AWAITING_PAYMENT'
            ? `TIX-2026-${String(Math.floor(Math.random() * 900000) + 100000)}-1`
            : null,
        paymentDueAt: opts.status === 'AWAITING_PAYMENT' ? new Date(Date.now() + 86_400_000) : null,
      })
      .returning();
    const [item] = await handle.db
      .insert(orderItems)
      .values({
        orderId: o!.id,
        eventId,
        kind: opts.seatId ? 'SEAT' : 'GENERAL_ADMISSION',
        seatId: opts.seatId ?? null,
        sectionId: opts.sectionId ?? (opts.seatId ? seatedId : floorId),
        priceCategoryId: categoryId,
        ticketTypeId: typeId,
        status: opts.itemStatus ?? 'CONFIRMED',
        sectionLabel: opts.seatId ? 'Stalls' : 'Floor',
        rowLabel: opts.seatId ? 'A' : null,
        seatLabel: opts.seatId ? '1' : null,
        categoryName: 'Cat 1',
        ticketTypeName: 'Normal',
        unitPriceGross: 2000,
        priceGross: 2000,
        taxRateBasisPoints: 1900,
        priceNet: 1680,
        taxAmount: 320,
        attendeeName: opts.attendeeName ?? null,
      })
      .returning();
    if ((opts.itemStatus ?? 'CONFIRMED') === 'CONFIRMED' && (opts.status ?? 'PAID') === 'PAID') {
      await ensureOrderTickets(ctx, o!.id);
    }
    return { order: o!, item: item! };
  }

  it('guest list and occupancy exclude test and cancelled orders', async () => {
    await order({ seatId: seatIds[0]!, first: 'Zoe', last: 'Alpha', attendeeName: 'Guest One' });
    await order({
      seatId: seatIds[1]!,
      first: 'Bea',
      last: 'Beta',
      itemStatus: 'PENDING',
      status: 'AWAITING_PAYMENT',
    });
    await order({ seatId: seatIds[2]!, first: 'Tess', last: 'Test', isTest: true });
    await order({
      seatId: seatIds[3]!,
      first: 'Carl',
      last: 'Cancelled',
      itemStatus: 'CANCELLED',
      status: 'CANCELLED',
    });
    await order({ first: 'Stan', last: 'Standing' });
    const checked = await order({ first: 'Ina', last: 'Inside' });
    await handle.db
      .update(tickets)
      .set({ checkInState: 'CHECKED_IN', firstCheckedInAt: new Date('2026-11-14T18:00:00Z') })
      .where(eq(tickets.orderId, checked.order.id));

    const byName = await loadGuestList(handle.db, eventId, 'name');
    expect(byName.map((r) => r.name)).toEqual(['Guest One', 'Ina Inside', 'Stan Standing']);
    expect(byName.find((r) => r.name === 'Ina Inside')).toMatchObject({
      checkInState: 'CHECKED_IN',
      ticketStatus: 'VALID',
    });
    expect(byName.some((r) => r.name.includes('Test'))).toBe(false);

    const occupancy = await loadOccupancy(handle.db, mapId);
    const stalls = occupancy.sections.find((s) => s.name === 'Stalls')!;
    expect(stalls.rows).toHaveLength(1);
    expect(stalls.rows[0]!.seats.map((s) => [s.label, s.status])).toEqual([
      ['1', 'SOLD'],
      ['2', 'RESERVED'],
      ['3', 'FREE'], // test order
      ['4', 'FREE'], // cancelled
      ['5', 'FREE'],
      ['6', 'BLOCKED'],
    ]);
    expect(stalls.rows[0]!.seats[0]!.holder).toBe('Guest One');
    expect(stalls.rows[0]!.seats[1]!.holder).toBe('Bea Beta');
    expect(stalls.rows[0]!.seats[2]!.holder).toBeNull();
    const floor = occupancy.sections.find((s) => s.name === 'Floor')!;
    expect(floor).toMatchObject({ capacity: 50, standingSold: 2, standingReserved: 0 });
    expect(occupancy.totals).toMatchObject({ SOLD: 3, RESERVED: 1, BLOCKED: 1 });
  });

  it('refuses an event without a seating plan', async () => {
    await expect(loadOccupancy(handle.db, null)).rejects.toThrow();
  });
});
