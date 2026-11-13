/**
 * Dashboard telemetry against real PostgreSQL and Redis: KPI aggregation, per-event inventory
 * (sold / reserved / live cart holds / available), payment breakdown and role-restricted blocks.
 * Throw-away database and key prefix.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  createDb,
  events,
  loadRootEnv,
  orderItems,
  orders,
  priceCategories,
  seatMapSections,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { sql } from 'drizzle-orm';
import { PresenceTracker } from '@tix/redis';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  getDashboardData,
  touchShopPresence,
  getDashboardPreferences,
  saveDashboardPreferences,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!adminUrl || !redisUrl)('dashboard telemetry (integration)', () => {
  const dbName = `tix_dash_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let eventId: string;
  let usdEventId: string;
  let archivedEventId: string;
  let draftEventId: string;
  let userA: string;
  let userB: string;

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

    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `h-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Hall',
        canvasWidth: 100,
        canvasHeight: 100,
      })
      .returning();
    const [section] = await handle.db
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
    const [tax] = await handle.db.select().from(taxRates).limit(1);
    const [event] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `show-${randomUUID().slice(0, 6)}`,
        title: 'Show',
        startsAt: new Date(Date.now() + 10 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
        status: 'PUBLISHED',
      })
      .returning();
    eventId = event!.id;
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId, name: 'Cat 1', color: '#112233', basePrice: 2000 })
      .returning();
    const [tariff] = await handle.db
      .insert(ticketTypes)
      .values({ eventId, name: 'Normal' })
      .returning();

    // Box-office orders need no buyer data (ONLINE orders require a customer).
    const baseOrder = {
      channel: 'BOX_OFFICE' as const,
      firstName: 'A',
      lastName: 'B',
      locale: 'en',
      currency: 'EUR',
    };
    const item = (orderId: string, status: 'CONFIRMED' | 'PENDING') => ({
      orderId,
      eventId,
      kind: 'GENERAL_ADMISSION' as const,
      sectionId: section!.id,
      priceCategoryId: category!.id,
      ticketTypeId: tariff!.id,
      status,
      sectionLabel: 'Floor',
      categoryName: 'Cat 1',
      ticketTypeName: 'Normal',
      unitPriceGross: 2000,
      priceGross: 2000,
      taxRateBasisPoints: 700,
      priceNet: 1869,
      taxAmount: 131,
    });
    const [paidOrder] = await handle.db
      .insert(orders)
      .values({
        ...baseOrder,
        orderNumber: `D-${randomUUID().slice(0, 8)}`,
        status: 'PAID',
        paymentMethod: 'PAYPAL',
        subtotalGross: 6000,
        totalGross: 6000,
        totalNet: 5607,
        totalTax: 393,
        amountPaid: 6000,
        amountRefunded: 1000,
        paidAt: new Date(),
      })
      .returning();
    const [openOrder] = await handle.db
      .insert(orders)
      .values({
        ...baseOrder,
        orderNumber: `D-${randomUUID().slice(0, 8)}`,
        status: 'AWAITING_PAYMENT',
        paymentMethod: 'BANK_TRANSFER',
        paymentReference: 'TIX-2026-123456-7',
        paymentDueAt: new Date(Date.now() + 5 * 86_400_000),
        subtotalGross: 4000,
        totalGross: 4000,
        totalNet: 3738,
        totalTax: 262,
      })
      .returning();
    await handle.db
      .insert(orderItems)
      .values([
        item(paidOrder!.id, 'CONFIRMED'),
        item(paidOrder!.id, 'CONFIRMED'),
        item(paidOrder!.id, 'CONFIRMED'),
        item(openOrder!.id, 'PENDING'),
        item(openOrder!.id, 'PENDING'),
      ]);
    // 4 spots held in carts (Redis).
    await redis.hset(ctx.keys.generalAdmissionHeld(eventId), section!.id, 4);

    // More events for the overview: another currency, an archived one with sales, a draft.
    const extraEvent = async (
      title: string,
      status: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT',
      cur: string,
      days: number,
    ) => {
      const [m] = await handle.db
        .insert(seatMaps)
        .values({
          venueId: venue!.id,
          kind: 'EVENT',
          name: title,
          canvasWidth: 100,
          canvasHeight: 100,
        })
        .returning();
      const [sec] = await handle.db
        .insert(seatMapSections)
        .values({
          seatMapId: m!.id,
          type: 'STANDING',
          name: 'Floor',
          ticketLabel: 'Floor',
          capacity: 30,
          geometry: { type: 'rect', x: 0, y: 0, width: 50, height: 50, rotation: 0 },
        })
        .returning();
      const [ev] = await handle.db
        .insert(events)
        .values({
          venueId: venue!.id,
          seatMapId: m!.id,
          slug: `x-${randomUUID().slice(0, 6)}`,
          title,
          startsAt: new Date(Date.now() + days * 86_400_000),
          timeZone: 'Europe/Berlin',
          currency: cur,
          taxRateId: tax!.id,
          status,
        })
        .returning();
      const [cat] = await handle.db
        .insert(priceCategories)
        .values({ eventId: ev!.id, name: 'Cat', color: '#112233', basePrice: 1000 })
        .returning();
      const [tar] = await handle.db
        .insert(ticketTypes)
        .values({ eventId: ev!.id, name: 'Normal' })
        .returning();
      return { id: ev!.id, sectionId: sec!.id, categoryId: cat!.id, tariffId: tar!.id };
    };
    const old = new Date(Date.now() - 40 * 86_400_000);
    const sell = async (
      e: { id: string; sectionId: string; categoryId: string; tariffId: string },
      cur: string,
      count: number,
      method: 'PAYPAL' | 'BANK_TRANSFER',
    ) => {
      const [o] = await handle.db
        .insert(orders)
        .values({
          ...baseOrder,
          currency: cur,
          orderNumber: `D-${randomUUID().slice(0, 8)}`,
          status: 'PAID',
          paymentMethod: method,
          subtotalGross: 1000 * count,
          totalGross: 1000 * count,
          totalNet: 900 * count,
          totalTax: 100 * count,
          amountPaid: 1000 * count,
          paidAt: old,
          createdAt: old,
        })
        .returning();
      await handle.db.insert(orderItems).values(
        Array.from({ length: count }, () => ({
          ...item(o!.id, 'CONFIRMED'),
          eventId: e.id,
          sectionId: e.sectionId,
          priceCategoryId: e.categoryId,
          ticketTypeId: e.tariffId,
          unitPriceGross: 1000,
          priceGross: 1000,
          priceNet: 935,
          taxAmount: 65,
        })),
      );
    };
    const usd = await extraEvent('USD show', 'PUBLISHED', 'USD', 12);
    usdEventId = usd.id;
    await sell(usd, 'USD', 2, 'PAYPAL');
    const archived = await extraEvent('Old show', 'ARCHIVED', 'EUR', -60);
    archivedEventId = archived.id;
    await sell(archived, 'EUR', 5, 'BANK_TRANSFER');
    const draft = await extraEvent('Draft show', 'DRAFT', 'EUR', 30);
    draftEventId = draft.id;
    await redis.hset(ctx.keys.generalAdmissionHeld(draftEventId), draft.sectionId, 3);
    await redis.hset(ctx.keys.generalAdmissionHeld(usdEventId), usd.sectionId, 1);

    const users = await handle.db
      .insert(adminUsers)
      .values([
        {
          email: `a-${randomUUID().slice(0, 6)}@example.test`,
          displayName: 'A',
          roles: ['EVENT_MANAGER'],
        },
        {
          email: `b-${randomUUID().slice(0, 6)}@example.test`,
          displayName: 'B',
          roles: ['FINANCE'],
        },
      ])
      .returning({ id: adminUsers.id });
    userA = users[0]!.id;
    userB = users[1]!.id;
  });

  afterAll(async () => {
    await redis?.del(
      ...[eventId, usdEventId, archivedEventId, draftEventId]
        .filter(Boolean)
        .map((id) => ctx.keys.generalAdmissionHeld(id)),
    );
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('aggregates KPIs, inventory and payment methods', async () => {
    const data = await getDashboardData(ctx, { money: true, inventory: true, checkIn: true });
    expect(data.currency).toBe('EUR');
    expect(data.kpis).toEqual({
      revenueTodayCents: 5000, // 6000 paid − 1000 refunded
      revenue7dCents: 5000,
      ordersToday: 2,
      ticketsSoldToday: 3,
      openVorkasseCents: 4000,
      openVorkasseCount: 1,
    });
    const event = data.events.find((e) => e.id === eventId)!;
    expect(event.inventory).toEqual({
      sold: 3,
      reserved: 2,
      locked: 4,
      blocked: 0,
      capacity: 100,
      available: 91,
    });
    expect(event.revenueCents).toBe(6000);
    expect(event.payments).toEqual([{ method: 'PAYPAL', tickets: 3, amountCents: 6000 }]);
    expect(event.queue).toEqual(expect.objectContaining({ active: 0, waiting: 0 }));
    expect(event.checkIn).toEqual({ checkedIn: 0, valid: 0 });
  });

  it('shows live shop presence (45 s window), separate from the waiting-room counter', async () => {
    const now = Date.now();
    const tracker = new PresenceTracker(ctx.redis, ctx.keys);
    await tracker.touch('visitor-1', [eventId], now - 5_000);
    await tracker.touch('visitor-2', [eventId], now - 30_000);
    await tracker.touch('left-long-ago', [eventId], now - 120_000);
    await touchShopPresence(ctx, 'visitor-3', [eventId]); // HTTP heartbeat of a cart page
    const data = await getDashboardData(ctx, { money: false, inventory: true, checkIn: false });
    const event = data.events.find((e) => e.id === eventId)!;
    expect(event.presence).toBe(3);
    expect(data.overview.presence).toBe(3);
    // The waiting-room admission counter is untouched.
    expect(event.queue).toEqual(expect.objectContaining({ active: 0 }));
    await tracker.remove('visitor-1', [eventId]); // tab closed
    const after = await getDashboardData(ctx, { money: false, inventory: true, checkIn: false });
    expect(after.events.find((e) => e.id === eventId)!.presence).toBe(2);
  });

  it('leaves out blocks the role may not see', async () => {
    const data = await getDashboardData(ctx, { money: false, inventory: false, checkIn: true });
    expect(data.kpis).toBeUndefined();
    const event = data.events.find((e) => e.id === eventId)!;
    expect(event.inventory).toBeUndefined();
    expect(event.queue).toBeUndefined();
    expect(event.payments).toBeUndefined();
    expect(event.revenueCents).toBeUndefined();
    expect(event.checkIn).toEqual({ checkedIn: 0, valid: 0 });
  });

  const ALL = ['DRAFT', 'PUBLISHED', 'POSTPONED', 'CANCELLED', 'ARCHIVED'] as const;
  const FULL = { money: true, inventory: true, checkIn: true };
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('uses published + postponed by default', async () => {
    const data = await getDashboardData(ctx, FULL);
    expect(data.events.map((e) => e.id).sort()).toEqual([eventId, usdEventId].sort());
    expect(data.overview.eventCount).toBe(2);
  });

  it('applies the status filter to overview and cards', async () => {
    const archived = await getDashboardData(ctx, { ...FULL, statuses: ['ARCHIVED'] });
    expect(archived.events.map((e) => e.id)).toEqual([archivedEventId]);
    expect(archived.overview.eventCount).toBe(1);
    expect(archived.overview.revenueCents).toBe(5000);
    expect(archived.overview.payments).toEqual([
      { method: 'BANK_TRANSFER', tickets: 5, amountCents: 5000 },
    ]);
    const none = await getDashboardData(ctx, { ...FULL, statuses: ['CANCELLED'] });
    expect(none.events).toEqual([]);
    expect(none.overview.eventCount).toBe(0);
    expect(none.overview.inventory?.capacity).toBe(0);
  });

  it('overview equals the sum of the event cards', async () => {
    const data = await getDashboardData(ctx, { ...FULL, statuses: [...ALL] });
    expect(data.events).toHaveLength(4);
    expect(data.overview.eventCount).toBe(4);
    const inv = data.overview.inventory!;
    for (const key of ['sold', 'reserved', 'locked', 'available', 'blocked', 'capacity'] as const) {
      expect(inv[key]).toBe(sum(data.events.map((e) => e.inventory![key])));
    }
    expect(inv).toEqual({
      sold: 10,
      reserved: 2,
      locked: 8,
      blocked: 0,
      capacity: 190,
      available: 170,
    });
    expect(data.overview.checkIn).toEqual({ checkedIn: 0, valid: 0 });
    expect(data.overview.queue).toEqual({ active: 0, waiting: 0, lobby: 0 });
    // Revenue and payments count the shop-currency events only (the USD event is left out).
    const eur = data.events.filter((e) => e.currency === 'EUR');
    expect(data.overview.revenueCents).toBe(sum(eur.map((e) => e.revenueCents!)));
    expect(data.overview.revenueCents).toBe(11_000);
    expect(data.overview.otherCurrencyEvents).toBe(1);
    expect(data.overview.payments).toEqual([
      { method: 'PAYPAL', tickets: 3, amountCents: 6000 },
      { method: 'BANK_TRANSFER', tickets: 5, amountCents: 5000 },
    ]);
  });

  it('does not limit the overview by the card cap', async () => {
    const data = await getDashboardData(ctx, { ...FULL, statuses: [...ALL], maxEvents: 1 });
    expect(data.events).toHaveLength(1);
    expect(data.overview.eventCount).toBe(4);
    expect(data.overview.inventory?.sold).toBe(10);
  });

  it('computes only what the role may see in the overview', async () => {
    const door = await getDashboardData(ctx, {
      money: false,
      inventory: false,
      checkIn: true,
      statuses: [...ALL],
    });
    expect(door.overview).toEqual({ eventCount: 4, checkIn: { checkedIn: 0, valid: 0 } });
    const finance = await getDashboardData(ctx, {
      money: true,
      inventory: false,
      checkIn: false,
      statuses: [...ALL],
    });
    expect(finance.overview.inventory).toBeUndefined();
    expect(finance.overview.queue).toBeUndefined();
    expect(finance.overview.checkIn).toBeUndefined();
    expect(finance.overview.revenueCents).toBe(11_000);
    expect(finance.events.every((e) => !e.inventory && !e.queue && !e.checkIn)).toBe(true);
  });

  it('orders cards by the saved order; unknown ids are ignored, new events come last', async () => {
    const unknown = randomUUID();
    const data = await getDashboardData(ctx, {
      ...FULL,
      statuses: [...ALL],
      eventOrder: [unknown, draftEventId, eventId],
    });
    const ids = data.events.map((e) => e.id);
    expect(ids.slice(0, 2)).toEqual([draftEventId, eventId]);
    expect(ids).not.toContain(unknown);
    expect(ids).toHaveLength(4);
  });

  it('validates and persists preferences per admin user', async () => {
    const defaults = { eventOrder: [], statusFilter: ['PUBLISHED', 'POSTPONED'] };
    expect(await getDashboardPreferences(ctx, userA)).toEqual(defaults);
    await saveDashboardPreferences(ctx, userA, { eventOrder: [eventId, usdEventId] });
    const saved = await saveDashboardPreferences(ctx, userA, { statusFilter: ['DRAFT'] });
    // Saving one key keeps the other.
    expect(saved).toEqual({ eventOrder: [eventId, usdEventId], statusFilter: ['DRAFT'] });
    expect(await getDashboardPreferences(ctx, userA)).toEqual(saved);
    // Another user is not affected.
    expect(await getDashboardPreferences(ctx, userB)).toEqual(defaults);
    // Invalid input is rejected and changes nothing.
    await expect(saveDashboardPreferences(ctx, userA, { eventOrder: ['x'] })).rejects.toThrow();
    await expect(saveDashboardPreferences(ctx, userA, { statusFilter: [] })).rejects.toThrow();
    await expect(
      saveDashboardPreferences(ctx, userA, { statusFilter: ['NOPE'] }),
    ).rejects.toThrow();
    await expect(saveDashboardPreferences(ctx, userA, { isAdmin: true })).rejects.toThrow();
    expect(await getDashboardPreferences(ctx, userA)).toEqual(saved);
    // Garbage that got into the column some other way falls back to the defaults.
    await handle.db.execute(
      sql`UPDATE admin_users SET dashboard_preferences = '{"eventOrder":"x","statusFilter":[1]}' WHERE id = ${userB}::uuid`,
    );
    expect(await getDashboardPreferences(ctx, userB)).toEqual(defaults);
  });
});
