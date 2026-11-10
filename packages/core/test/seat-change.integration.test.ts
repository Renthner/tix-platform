/**
 * Seat change of existing orders (Platzwechsel) against real PostgreSQL + Redis (throw-away
 * database, own Redis prefix). No object storage: the job queue is a mock, no PDF is rendered.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  createDb,
  emailMessages,
  events,
  loadRootEnv,
  orderHistory,
  orderItems,
  orders,
  priceCategories,
  priceCategoryTicketTypes,
  seatMaps,
  taxRates,
  ticketTypes,
  tickets,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { parseTicketPayload, type SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  afterSeatMapSaved,
  boxOfficeSessionId,
  cancelPaidOrder,
  changeOrderSeats,
  createBoxOfficeOrder,
  createCoreContext,
  getEventById,
  holdBoxOfficeSeats,
  saveSeatMapDocument,
  type CoreContext,
  type EventRow,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('seat change of orders (integration)', () => {
  const dbName = `tix_seatchange_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let event: EventRow;
  /** Index 0-15 category 1 (30 €), 16-23 category 2 (40 €); 23 is blocked (press). */
  let seatIds: string[] = [];
  let standingId: string;
  let normalId: string;
  let userId: string;
  const jobs = { add: vi.fn(async () => 'job'), close: async () => {} };
  const BLOCKED = 23;

  const taken = async (seatId: string) => (await ctx.seats.takenSeats(event.id))[seatId] ?? null;
  const sell = async (seatIndexes: number[], email?: string) => {
    const result = await createBoxOfficeOrder(ctx, {
      userId,
      channel: 'BOX_OFFICE',
      payment: 'CASH',
      sendEmail: false,
      allowBlocked: true,
      buyer: email ? { email, firstName: 'Ann', lastName: 'Buyer' } : {},
      lines: seatIndexes.map((i) => ({
        eventId: event.id,
        seatId: seatIds[i]!,
        ticketTypeId: normalId,
      })),
    });
    const items = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, result.orderId))
      .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
    return { orderId: result.orderId, items };
  };
  const hold = (tabId: string, ...indexes: number[]) =>
    holdBoxOfficeSeats(ctx, {
      userId,
      tabId,
      eventId: event.id,
      seatIds: indexes.map((i) => seatIds[i]!),
    });
  const change = (
    orderId: string,
    pairs: [string, number][],
    tabId: string | null,
    extra: Partial<Parameters<typeof changeOrderSeats>[1]> = {},
  ) =>
    changeOrderSeats(ctx, {
      orderId,
      changes: pairs.map(([orderItemId, i]) => ({ orderItemId, newSeatId: seatIds[i]! })),
      userId,
      holdSessionId: boxOfficeSessionId(userId, tabId ?? uuid()),
      notify: false,
      ...extra,
    });
  const validTickets = (orderId: string) =>
    handle.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'VALID')));
  const itemOf = async (id: string) =>
    (await handle.db.select().from(orderItems).where(eq(orderItems.id, id)))[0]!;

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
      appUrl: 'https://shop.example.org/',
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry())),
      jobs: jobs as unknown as JobQueues,
    });

    const [user] = await handle.db
      .insert(adminUsers)
      .values({ email: 'mgr@example.invalid', displayName: 'Mgr', roles: ['EVENT_MANAGER'] })
      .returning({ id: adminUsers.id });
    userId = user!.id;
    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Hall',
        canvasWidth: 800,
        canvasHeight: 600,
      })
      .returning();
    const [tax] = await handle.db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 1900 })
      .returning();
    const [ev] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `show-${uuid().slice(0, 6)}`,
        title: 'Show',
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
        orphanSeatRuleEnabled: false,
      })
      .returning();
    const [cat1] = await handle.db
      .insert(priceCategories)
      .values({ eventId: ev!.id, name: 'Cat 1', color: '#336699', basePrice: 3000 })
      .returning();
    const [cat2] = await handle.db
      .insert(priceCategories)
      .values({ eventId: ev!.id, name: 'Cat 2', color: '#993366', basePrice: 4000 })
      .returning();
    const [normal] = await handle.db
      .insert(ticketTypes)
      .values({ eventId: ev!.id, name: 'Normal', isDefault: true })
      .returning();
    normalId = normal!.id;
    await handle.db.insert(priceCategoryTicketTypes).values([
      { priceCategoryId: cat1!.id, ticketTypeId: normal!.id },
      { priceCategoryId: cat2!.id, ticketTypeId: normal!.id },
    ]);

    const sectionId = uuid();
    const rowId = uuid();
    standingId = uuid();
    const doc: SeatMapDocumentInput = {
      version: 1,
      name: 'Hall',
      canvasWidth: 800,
      canvasHeight: 600,
      sections: [
        {
          id: sectionId,
          type: 'SEATED',
          name: 'Stalls',
          ticketLabel: 'Stalls',
          geometry: { type: 'rect', x: 0, y: 0, width: 800, height: 100 },
        },
        {
          id: standingId,
          type: 'STANDING',
          name: 'Floor',
          ticketLabel: 'Floor',
          capacity: 3,
          priceCategoryId: cat1!.id,
          geometry: { type: 'rect', x: 0, y: 200, width: 400, height: 100 },
        },
      ],
      rows: [
        {
          id: rowId,
          sectionId,
          label: 'A',
          sortOrder: 1,
          geometry: {
            curve: { type: 'straight', start: { x: 20, y: 20 }, end: { x: 740, y: 20 } },
            seatSpacing: 30,
          },
        },
      ],
      seats: Array.from({ length: 24 }, (_, i) => ({
        id: uuid(),
        sectionId,
        rowId,
        label: String(i + 1),
        position: i + 1,
        x: 20 + i * 30,
        y: 20,
        priceCategoryId: i >= 16 ? cat2!.id : cat1!.id,
        ...(i === BLOCKED ? { blockReason: 'PRESS' as const } : {}),
      })),
    };
    const saved = await saveSeatMapDocument(handle.db, map!.id, doc, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) await afterSeatMapSaved(ctx, saved);
    seatIds = doc.seats!.map((s) => s.id!);
    event = await getEventById(ctx, ev!.id);
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) {
      const keys = await redis.keys(`${ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('PAID: the ticket is re-issued for the new seat, the old seat is sellable again', async () => {
    const { orderId, items } = await sell([0], 'ann@example.org');
    const item = items[0]!;
    const [oldTicket] = await validTickets(orderId);
    expect(await taken(seatIds[0]!)).toBe('S');
    const [before] = await handle.db.select().from(orders).where(eq(orders.id, orderId));

    const tabId = uuid();
    await hold(tabId, 5);
    const result = await change(orderId, [[item.id, 5]], tabId, {
      notify: true,
      reason: 'Guest asked',
      expectedVersion: before!.version,
    });
    expect(result.reissuedTickets).toBe(1);
    expect(result.emailQueued).toBe(true);

    expect(await itemOf(item.id)).toMatchObject({
      seatId: seatIds[5],
      seatLabel: '6',
      rowLabel: 'A',
      status: 'CONFIRMED',
      priceGross: item.priceGross,
      unitPriceGross: item.unitPriceGross,
    });
    const all = await handle.db.select().from(tickets).where(eq(tickets.orderId, orderId));
    const old = all.find((t) => t.id === oldTicket!.id)!;
    expect(old.status).toBe('REPLACED');
    const valid = all.filter((t) => t.status === 'VALID');
    expect(valid).toHaveLength(1);
    expect(old.replacedByTicketId).toBe(valid[0]!.id);
    expect(valid[0]!.qrPayload).not.toBe(old.qrPayload);
    expect(parseTicketPayload(valid[0]!.qrPayload)!.seatInfo.endsWith('|A|6')).toBe(true);
    expect(parseTicketPayload(old.qrPayload)!.seatInfo.endsWith('|A|1')).toBe(true);

    // Mirror: old seat sellable, new seat sold, no leftover hold lock.
    expect(await taken(seatIds[0]!)).toBeNull();
    expect(await taken(seatIds[5]!)).toBe('S');
    expect(await ctx.seats.sessionSeatIds(event.id, boxOfficeSessionId(userId, tabId))).toEqual([]);
    const lock = await ctx.seats.lockSeats({
      eventId: event.id,
      sessionId: `k${uuid().slice(0, 8)}`,
      seatIds: [seatIds[0]!],
      expiresAt: Date.now() + 60_000,
      maxPerSession: 0,
    });
    expect(lock.ok).toBe(true);

    const [history] = await handle.db
      .select()
      .from(orderHistory)
      .where(and(eq(orderHistory.orderId, orderId), eq(orderHistory.type, 'seats_changed')));
    expect(history!.actorUserId).toBe(userId);
    expect(history!.data).toMatchObject({
      reason: 'Guest asked',
      changes: [
        {
          from: { seatLabel: '1', seatId: seatIds[0] },
          to: { seatLabel: '6', seatId: seatIds[5] },
        },
      ],
    });
    const [orderAfter] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
    expect(orderAfter!.version).toBe(before!.version + 1);
    const mails = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, orderId));
    expect(mails.filter((m) => m.templateKey === 'TICKETS_RESENT')).toHaveLength(1);

    // A stale admin page is refused.
    await hold(tabId, 6);
    await expect(
      change(orderId, [[item.id, 6]], tabId, { expectedVersion: before!.version }),
    ).rejects.toMatchObject({ code: 'ORDER_CHANGED' });
    await ctx.seats.releaseSeats(event.id, boxOfficeSessionId(userId, tabId), [seatIds[6]!]);
  });

  it('swaps two seats of one order without a hold', async () => {
    const { orderId, items } = await sell([1, 2]);
    const [a, b] = items;
    const idx = (seatId: string | null) => seatIds.indexOf(seatId!);
    await change(
      orderId,
      [
        [a!.id, idx(b!.seatId)],
        [b!.id, idx(a!.seatId)],
      ],
      null,
    );
    const after = await handle.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const seatOf = (id: string) => after.find((i) => i.id === id)!.seatId;
    expect(seatOf(a!.id)).toBe(b!.seatId);
    expect(seatOf(b!.id)).toBe(a!.seatId);
    expect(after.every((i) => i.status === 'CONFIRMED')).toBe(true);
    expect(await validTickets(orderId)).toHaveLength(2);
    expect(await taken(seatIds[1]!)).toBe('S');
    expect(await taken(seatIds[2]!)).toBe('S');
  });

  it('rejects a seat with a different price (nothing changes)', async () => {
    const { orderId, items } = await sell([3]);
    const tabId = uuid();
    await hold(tabId, 16);
    await expect(change(orderId, [[items[0]!.id, 16]], tabId)).rejects.toMatchObject({
      code: 'SEAT_PRICE_DIFFERS',
    });
    expect((await itemOf(items[0]!.id)).seatId).toBe(seatIds[3]);
    expect(await taken(seatIds[3]!)).toBe('S');
    await ctx.seats.releaseSeats(event.id, boxOfficeSessionId(userId, tabId), [seatIds[16]!]);
  });

  it('same category keeps the price paid even if the price table changed; unit price follows the category', async () => {
    const { orderId, items } = await sell([12]);
    await handle.db
      .update(orderItems)
      .set({
        unitPriceGross: 3000,
        discountAmount: 500,
        priceGross: 2500,
        priceNet: 2101,
        taxAmount: 399,
      })
      .where(eq(orderItems.id, items[0]!.id));
    const tabId = uuid();
    await hold(tabId, 15);
    await change(orderId, [[items[0]!.id, 15]], tabId);
    expect(await itemOf(items[0]!.id)).toMatchObject({
      seatId: seatIds[15],
      priceGross: 2500,
      unitPriceGross: 3000,
      discountAmount: 500,
    });
    // Cross-category move at the same paid price is fine: Cat 2 costs 40 €, paid 40 € -> allowed.
    const second = await sell([18]);
    const tab2 = uuid();
    await hold(tab2, 19);
    await change(second.orderId, [[second.items[0]!.id, 19]], tab2);
    expect((await itemOf(second.items[0]!.id)).seatId).toBe(seatIds[19]);
  });

  it('refuses seats held by an online cart or not held; foreign hold sessions are unusable', async () => {
    const { orderId, items } = await sell([4]);
    const online = `k${uuid().slice(0, 8)}`;
    await ctx.seats.lockSeats({
      eventId: event.id,
      sessionId: online,
      seatIds: [seatIds[7]!],
      expiresAt: Date.now() + 60_000,
      maxPerSession: 0,
    });
    await expect(hold(uuid(), 7)).rejects.toMatchObject({ code: 'SEAT_LOCKED' });
    await expect(change(orderId, [[items[0]!.id, 7]], uuid())).rejects.toMatchObject({
      code: 'HOLD_EXPIRED',
    });
    // An online session (or another user's) is never converted.
    await expect(
      changeOrderSeats(ctx, {
        orderId,
        changes: [{ orderItemId: items[0]!.id, newSeatId: seatIds[7]! }],
        userId,
        holdSessionId: online,
        notify: false,
      }),
    ).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
    expect(await ctx.seats.sessionSeatIds(event.id, online)).toEqual([seatIds[7]]);
    expect((await itemOf(items[0]!.id)).seatId).toBe(seatIds[4]);
  });

  it('AWAITING order: PENDING item moves, mirror R, no tickets and no mail', async () => {
    const { orderId, items } = await sell([8], 'wait@example.org');
    // Turn the sale into an unpaid order (fixture).
    await handle.db
      .update(tickets)
      .set({ status: 'CANCELLED', voidedAt: new Date() })
      .where(eq(tickets.orderId, orderId));
    await handle.db
      .update(orderItems)
      .set({ status: 'PENDING' })
      .where(eq(orderItems.orderId, orderId));
    await handle.db
      .update(orders)
      .set({
        status: 'AWAITING_PAYMENT',
        paymentReference: `TIX-2026-${Math.floor(1e5 + Math.random() * 8e5)}-7`,
        paymentDueAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(orders.id, orderId));
    await ctx.seats.setTaken(event.id, { [seatIds[8]!]: 'R' });

    const tabId = uuid();
    await hold(tabId, 9);
    const result = await change(orderId, [[items[0]!.id, 9]], tabId, { notify: true });
    expect(result).toMatchObject({ reissuedTickets: 0, emailQueued: false });
    expect(await itemOf(items[0]!.id)).toMatchObject({ seatId: seatIds[9], status: 'PENDING' });
    expect(await taken(seatIds[8]!)).toBeNull();
    expect(await taken(seatIds[9]!)).toBe('R');
    expect(await validTickets(orderId)).toHaveLength(0);
  });

  it('blocked seats only with allowBlocked', async () => {
    const { orderId, items } = await sell([16]);
    await expect(change(orderId, [[items[0]!.id, BLOCKED]], null)).rejects.toMatchObject({
      code: 'SEAT_BLOCKED',
    });
    await change(orderId, [[items[0]!.id, BLOCKED]], null, { allowBlocked: true });
    expect(await itemOf(items[0]!.id)).toMatchObject({ seatId: seatIds[BLOCKED] });
    expect(await taken(seatIds[BLOCKED]!)).toBe('S');
    expect(await taken(seatIds[16]!)).toBeNull();
    // A second order cannot take the (now sold) blocked seat: the unique index / mirror guards it.
    const second = await sell([17]);
    await expect(
      change(second.orderId, [[second.items[0]!.id, BLOCKED]], null, { allowBlocked: true }),
    ).rejects.toMatchObject({ code: 'SEAT_UNAVAILABLE' });
  });

  it('refuses standing and foreign items and invalid selections', async () => {
    const a = await sell([13]);
    const b = await sell([14]);
    const ga = await createBoxOfficeOrder(ctx, {
      userId,
      channel: 'BOX_OFFICE',
      payment: 'CASH',
      sendEmail: false,
      lines: [{ eventId: event.id, sectionId: standingId, quantity: 1, ticketTypeId: normalId }],
    });
    const [gaItem] = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, ga.orderId));
    await expect(change(ga.orderId, [[gaItem!.id, 15]], uuid())).rejects.toMatchObject({
      code: 'ITEM_NOT_SEAT',
    });
    await expect(change(a.orderId, [[b.items[0]!.id, 15]], uuid())).rejects.toMatchObject({
      code: 'ORDER_ITEM_NOT_FOUND',
    });
    await expect(
      change(
        a.orderId,
        [
          [a.items[0]!.id, 15],
          [a.items[0]!.id, 12],
        ],
        uuid(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(change(a.orderId, [[a.items[0]!.id, 13]], uuid())).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('is serialised with cancelPaidOrder (consistent end state either way)', async () => {
    const { orderId, items } = await sell([10]);
    const tabId = uuid();
    await hold(tabId, 11);
    const [moved, cancelled] = await Promise.allSettled([
      change(orderId, [[items[0]!.id, 11]], tabId),
      cancelPaidOrder(ctx, { orderId, refundFees: false, notify: false, userId }),
    ]);
    expect(cancelled.status).toBe('fulfilled');
    if (moved.status === 'rejected') {
      expect(['ITEM_NOT_ACTIVE', 'ORDER_NOT_CHANGEABLE', 'ORDER_CHANGED']).toContain(
        (moved.reason as { code?: string }).code,
      );
    }
    expect((await itemOf(items[0]!.id)).status).toBe('REFUNDED');
    expect(await validTickets(orderId)).toHaveLength(0);
    const active = await handle.db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.status, 'CONFIRMED'), eq(orderItems.orderId, orderId)));
    expect(active).toHaveLength(0);
  });
});
