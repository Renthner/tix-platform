/**
 * End-to-end tests of the core domain services against real PostgreSQL + Redis:
 * editor save/clone, inventory mirror, multi-event cart, best available, orphan rule,
 * waiting room access decisions.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  accessCodes,
  events,
  loadRootEnv,
  orderItems,
  orders,
  customers,
  priceCategories,
  priceCategoryTicketTypes,
  svgSymbols,
  queueConfigs,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import type { SeatMapDocumentInput } from '@tix/shared';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSeats,
  afterSeatMapSaved,
  createSymbol,
  deleteArchivedEvent,
  discardCart,
  removeSeats,
  getPublicSeatMap,
  invalidatePublicSeatMap,
  seatMapVersion,
  bestAvailable,
  claimPass,
  cloneSeatMap,
  createCoreContext,
  enterShop,
  getAvailability,
  getCart,
  getEventById,
  loadSeatMapDocument,
  saveSeatMapDocument,
  setTariff,
  sweepExpiredLocks,
  tickWaitingRooms,
  validateSelection,
  type CoreContext,
  type EventRow,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

/** Template with one section and two rows (A: 6 seats, B: 6 seats). */
function templateDoc(version: number): SeatMapDocumentInput & { sections: { id: string }[] } {
  const sectionId = uuid();
  const rowA = uuid();
  const rowB = uuid();
  const seat = (rowId: string, n: number, y: number) => ({
    id: uuid(),
    sectionId,
    rowId,
    label: String(n),
    position: n,
    x: n * 20,
    y,
  });
  return {
    version,
    name: 'Main hall',
    canvasWidth: 1000,
    canvasHeight: 800,
    sections: [
      {
        id: sectionId,
        type: 'SEATED',
        name: 'Stalls',
        ticketLabel: 'Stalls',
        geometry: { type: 'rect', x: 0, y: 0, width: 200, height: 100 },
      },
    ],
    rows: [
      {
        id: rowA,
        sectionId,
        label: 'A',
        sortOrder: 1,
        geometry: {
          curve: { type: 'straight', start: { x: 20, y: 10 }, end: { x: 120, y: 10 } },
          seatSpacing: 20,
        },
      },
      {
        id: rowB,
        sectionId,
        label: 'B',
        sortOrder: 2,
        geometry: {
          curve: { type: 'straight', start: { x: 20, y: 40 }, end: { x: 120, y: 40 } },
          seatSpacing: 20,
        },
      },
    ],
    seats: [1, 2, 3, 4, 5, 6].flatMap((n) => [seat(rowA, n, 10), seat(rowB, n, 40)]),
  };
}

describe.skipIf(!adminUrl || !redisUrl)('core services (integration)', () => {
  const dbName = `tix_core_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let templateId: string;
  let event: EventRow;
  let categoryId: string;

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
    });

    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [template] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'TEMPLATE',
        name: 'Main hall',
        canvasWidth: 1000,
        canvasHeight: 800,
      })
      .returning();
    templateId = template!.id;
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

  it('saves a template document and renumbers rows without unique conflicts', async () => {
    const doc = templateDoc(1);
    const first = await saveSeatMapDocument(handle.db, templateId, doc, null);
    expect(first.ok && first.version).toBe(2);

    const loaded = (await loadSeatMapDocument(handle.db, templateId))!;
    expect(loaded.seats).toHaveLength(12);
    // swap row labels A <-> B and reverse seat numbers in one save
    for (const row of loaded.rows) row.label = row.label === 'A' ? 'B' : 'A';
    for (const seat of loaded.seats) {
      seat.label = String(7 - Number(seat.label));
      seat.position = 7 - seat.position!;
    }
    const second = await saveSeatMapDocument(handle.db, templateId, loaded, null);
    expect(second.ok).toBe(true);

    const stale = await saveSeatMapDocument(handle.db, templateId, loaded, null);
    expect(stale.ok === false && stale.error.code).toBe('VERSION_CONFLICT');
  });

  it('clones the template into an editable event map with categories and tariffs', async () => {
    const [tax] = await handle.db
      .insert(taxRates)
      .values({ name: `t-${uuid()}`, rateBasisPoints: 700 })
      .returning();
    const [venue] = await handle.db
      .select({ id: seatMaps.venueId })
      .from(seatMaps)
      .where(eq(seatMaps.id, templateId));
    const eventMapId = await handle.db.transaction((tx) =>
      cloneSeatMap(tx, templateId, { kind: 'EVENT', name: 'Gala' }),
    );
    const [ev] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: eventMapId,
        slug: `gala-${uuid().slice(0, 6)}`,
        title: 'Gala',
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
        orphanSeatRuleEnabled: true,
        maxTicketsPerOrder: 6,
      })
      .returning();
    event = ev!;
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId: event.id, name: 'Cat 1', color: '#336699', basePrice: 4000 })
      .returning();
    categoryId = category!.id;
    const [normal] = await handle.db
      .insert(ticketTypes)
      .values({ eventId: event.id, name: 'Normal', isDefault: true })
      .returning();
    const [reduced] = await handle.db
      .insert(ticketTypes)
      .values({
        eventId: event.id,
        name: 'Reduced',
        discountKind: 'PERCENT',
        discountValue: 5000,
        requiresProofAtEntry: true,
        scannerWarning: 'Check ID',
      })
      .returning();
    await handle.db.insert(priceCategoryTicketTypes).values([
      { priceCategoryId: categoryId, ticketTypeId: normal!.id },
      { priceCategoryId: categoryId, ticketTypeId: reduced!.id },
    ]);

    // assign the category to every seat in the editor, block one seat (camera position)
    const doc = (await loadSeatMapDocument(handle.db, eventMapId))!;
    for (const seat of doc.seats) seat.priceCategoryId = categoryId;
    const camera = doc.seats.find((s) => s.label === '6')!;
    camera.blockReason = 'TECHNICAL';
    const saved = await saveSeatMapDocument(handle.db, eventMapId, doc, null);
    expect(saved.ok).toBe(true);
    expect(saved.ok && saved.blockedSeatIds).toEqual([camera.id]);
  });

  it('runs the multi-seat cart: lock, tariff per seat, availability, orphan rule', async () => {
    const sid = `s${uuid().slice(0, 8)}`;
    const decision = await enterShop(ctx, event, sid); // global queue config absent → OFF
    expect(decision.status).toBe('GRANTED');

    const map = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
    const front = map.rows.find((r) => r.sortOrder === 1)!;
    const rowSeats = map.seats
      .filter((s) => s.rowId === front.id)
      .sort((a, b) => a.position! - b.position!);

    // pick seats 2+3 → seat 1 would be stranded → rule violated
    await addSeats(ctx, sid, event, [rowSeats[1]!.id, rowSeats[2]!.id]);
    const check = await validateSelection(ctx, sid, event);
    expect(check.ok).toBe(false);
    expect(check.orphanSeatIds).toEqual([rowSeats[0]!.id]);

    await addSeats(ctx, sid, event, [rowSeats[0]!.id]);
    expect((await validateSelection(ctx, sid, event)).ok).toBe(true);

    const other = await getAvailability(ctx, 'someone-else', event);
    expect(other.locked).toHaveLength(3);
    expect(other.mine).toEqual([]);

    const cart = await getCart(ctx, sid);
    expect(cart.itemCount).toBe(3);
    expect(cart.totalGross).toBe(12_000);
    const reduced = cart.events[0]!.ticketTypes.find((t) => t.name === 'Reduced')!;
    await setTariff(ctx, sid, event, rowSeats[0]!.id, reduced.id);
    expect((await getCart(ctx, sid)).totalGross).toBe(10_000);

    await expect(
      addSeats(ctx, `x${uuid().slice(0, 8)}`, event, [rowSeats[0]!.id]),
    ).rejects.toMatchObject({ code: 'SEAT_LOCKED' });
  });

  it('finds and locks the best contiguous seats, skipping blocked seats', async () => {
    const sid = `b${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, sid);
    const result = await bestAvailable(ctx, sid, event, categoryId, 2);
    expect(result.seatIds).toHaveLength(2);
    const taken = await ctx.seats.takenSeats(event.id);
    expect(result.seatIds.some((id) => taken[id] === 'B')).toBe(false);
  });

  it('refuses to remove a sold seat from the event map but soft-removes historical ones', async () => {
    const doc = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
    const sold = doc.seats.find((s) => s.blockReason === null)!;
    const [customer] = await handle.db
      .insert(customers)
      .values({ email: `c${uuid()}@example.org`, firstName: 'A', lastName: 'B' })
      .returning();
    const [order] = await handle.db
      .insert(orders)
      .values({
        orderNumber: uuid(),
        customerId: customer!.id,
        status: 'PAID',
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email: customer!.email,
        firstName: 'A',
        lastName: 'B',
        locale: 'en',
        currency: 'EUR',
        subtotalGross: 4000,
        totalGross: 4000,
        totalNet: 3738,
        totalTax: 262,
        amountPaid: 4000,
        paidAt: new Date(),
      })
      .returning();
    const [type] = await handle.db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, event.id))
      .limit(1);
    const [item] = await handle.db
      .insert(orderItems)
      .values({
        orderId: order!.id,
        eventId: event.id,
        kind: 'SEAT',
        seatId: sold.id,
        sectionId: sold.sectionId,
        priceCategoryId: categoryId,
        ticketTypeId: type!.id,
        status: 'CONFIRMED',
        sectionLabel: 'Stalls',
        categoryName: 'Cat 1',
        ticketTypeName: type!.name,
        unitPriceGross: 4000,
        priceGross: 4000,
        taxRateBasisPoints: 700,
        priceNet: 3738,
        taxAmount: 262,
      })
      .returning();

    const without = { ...doc, seats: doc.seats.filter((s) => s.id !== sold.id) };
    const rejected = await saveSeatMapDocument(handle.db, event.seatMapId!, without, null);
    expect(rejected.ok === false && rejected.error.code).toBe('SEATS_IN_USE');

    await handle.db
      .update(orderItems)
      .set({ status: 'CANCELLED', cancelledAt: new Date() })
      .where(eq(orderItems.id, item!.id));
    const accepted = await saveSeatMapDocument(handle.db, event.seatMapId!, without, null);
    expect(accepted.ok && accepted.removedSeatIds).toEqual([sold.id]);
    const reloaded = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
    expect(reloaded.seats.some((s) => s.id === sold.id)).toBe(false);
  });

  it('queues visitors when the threshold is reached and asks for codes in VIP mode', async () => {
    await handle.db.insert(queueConfigs).values({
      eventId: event.id,
      mode: 'AUTO_THRESHOLD',
      activeSessionThreshold: 1,
      admissionBatchSize: 1,
      admissionIntervalSeconds: 5,
      passTokenTtlSeconds: 600,
    });
    const fresh = await getEventById(ctx, event.id);
    // earlier test sessions already hold passes → capacity of 1 is exhausted
    const decision = await enterShop(ctx, fresh, `q${uuid().slice(0, 8)}`);
    expect(decision.status).toBe('QUEUED');

    await handle.db
      .update(queueConfigs)
      .set({ mode: 'VIP_CODE_ONLY' })
      .where(eq(queueConfigs.eventId, event.id));
    expect((await enterShop(ctx, fresh, `v${uuid().slice(0, 8)}`)).status).toBe('CODE_REQUIRED');
  });

  it('admits the queue in batches (HYBRID) and lets admitted visitors claim a pass', async () => {
    await ctx.queue.reset(event.id);
    await handle.db
      .update(queueConfigs)
      .set({
        mode: 'HYBRID',
        activeSessionThreshold: 1000,
        admissionBatchSize: 2,
        admissionIntervalSeconds: 1,
      })
      .where(eq(queueConfigs.eventId, event.id));
    const fresh = await getEventById(ctx, event.id);
    const sessions = Array.from({ length: 3 }, () => `h${uuid().slice(0, 8)}`);
    for (const sid of sessions) expect((await enterShop(ctx, fresh, sid)).status).toBe('QUEUED');

    await tickWaitingRooms(ctx);
    const admitted = await Promise.all(sessions.map((sid) => ctx.queue.position(event.id, sid)));
    expect(admitted.filter((p) => p.admittedAt !== null)).toHaveLength(2);

    const granted = await claimPass(ctx, fresh, sessions[0]!);
    expect(granted.status).toBe('GRANTED');
  });

  it('sweeps expired seat locks and frees the seats for others', async () => {
    const map = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
    const seat = map.seats.find((s) => s.blockReason === null)!;
    await ctx.seats.releaseSeats(event.id, 'sweeper', [seat.id]);
    const lock = await ctx.seats.lockSeats({
      eventId: event.id,
      sessionId: 'sweeper',
      seatIds: [seat.id],
      expiresAt: Date.now() + 50,
      maxPerSession: 0,
    });
    // the seat may already be held by an earlier test session – only assert when we got it
    if (lock.ok) {
      await new Promise((r) => setTimeout(r, 120));
      expect(await sweepExpiredLocks(ctx)).toBeGreaterThanOrEqual(1);
      expect((await getAvailability(ctx, 'other', event)).locked).not.toContain(seat.id);
    }
  });

  it('applies per-category tariff discounts and ships referenced symbols in the public map', async () => {
    const [reduced] = await handle.db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.name, 'Reduced'));
    // tariff default = −50 %; in this category: −5 € instead
    await handle.db
      .update(priceCategoryTicketTypes)
      .set({ discountKind: 'FIXED_AMOUNT', discountValue: 500 })
      .where(eq(priceCategoryTicketTypes.ticketTypeId, reduced!.id));
    const symbol = await createSymbol(handle.db, {
      name: 'Test chair',
      kind: 'SEAT',
      svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></svg>',
      colorize: true,
      createdByUserId: null,
    });
    const doc = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
    doc.seats[0]!.symbolId = symbol.id;
    doc.sections[0]!.showNameOnMap = false;
    const saved = await saveSeatMapDocument(handle.db, event.seatMapId!, doc, null);
    expect(saved.ok).toBe(true);

    const fresh = await getEventById(ctx, event.id);
    await invalidatePublicSeatMap(ctx, event.id, await seatMapVersion(ctx, fresh.seatMapId!));
    const map = await getPublicSeatMap(ctx, fresh);
    expect(map.ticketTypes.find((t) => t.name === 'Reduced')!.prices[categoryId]).toBe(3500);
    expect(map.symbols.map((s) => s.id)).toContain(symbol.id);
    expect(map.seats.find((s) => s.i === doc.seats[0]!.id)!.m).toBe(symbol.id);
    expect(map.sections[0]!.showNameOnMap).toBe(false);

    const unknown = await saveSeatMapDocument(
      handle.db,
      event.seatMapId!,
      {
        ...(await loadSeatMapDocument(handle.db, event.seatMapId!))!,
        settings: { defaultSeatSymbolId: uuid() },
      },
      null,
    );
    expect(unknown.ok === false && unknown.error.code).toBe('VALIDATION_FAILED');
    await handle.db.delete(svgSymbols).where(eq(svgSymbols.id, symbol.id));
  });

  it('restarts the reservation time of the whole cart when a seat is added (not when removed)', async () => {
    const sid = `t${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, sid);
    const availability = await getAvailability(ctx, sid, event);
    const busy = new Set([...availability.locked, ...availability.taken]);
    const map = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
    const free = map.seats.filter((s) => s.blockReason === null && !busy.has(s.id));
    const [first, second] = [free[0]!, free[free.length - 1]!];

    await addSeats(ctx, sid, event, [first.id]);
    const before = (await getCart(ctx, sid)).expiresAt!;
    await new Promise((r) => setTimeout(r, 1_100));
    await addSeats(ctx, sid, event, [second.id]);
    const after = (await getCart(ctx, sid)).expiresAt!;
    expect(after).toBeGreaterThanOrEqual(before + 1_000);
    // the earlier seat's lock was moved to the new expiry as well
    expect(Number(await ctx.redis.zscore(ctx.keys.seatLockExpiries(event.id), first.id))).toBe(
      after,
    );

    await new Promise((r) => setTimeout(r, 50));
    await removeSeats(ctx, sid, event.id, [second.id]);
    expect((await getCart(ctx, sid)).expiresAt).toBe(after);
    await discardCart(ctx, sid);
  });

  it('allows a companion seat alone only when its wheelchair space is already sold', async () => {
    const doc = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
    const sid = `c${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, sid);
    const availability = await getAvailability(ctx, sid, event);
    const busy = new Set([...availability.locked, ...availability.taken]);
    // two adjacent free seats: wheelchair space + companion seat
    const pair = doc.seats
      .filter((s) => s.blockReason === null && s.rowId && !busy.has(s.id))
      .map((s) => [s, doc.seats.find((o) => o.rowId === s.rowId && o.position === s.position! + 1)])
      .find(([, next]) => next && next.blockReason === null && !busy.has(next.id))!;
    const [wheelchair, companion] = [pair[0]!, pair[1]!];
    const flagged = {
      ...doc,
      seats: doc.seats.map((s) =>
        s.id === wheelchair.id
          ? { ...s, isWheelchairSpace: true }
          : s.id === companion.id
            ? { ...s, isCompanionSeat: true }
            : s,
      ),
    };
    const saved = await saveSeatMapDocument(handle.db, event.seatMapId!, flagged, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) await afterSeatMapSaved(ctx, saved);
    const strict = { ...event, companionRequiresWheelchair: true, orphanSeatRuleEnabled: false };

    await addSeats(ctx, sid, strict, [companion.id]);
    let check = await validateSelection(ctx, sid, strict);
    expect(check.ok).toBe(false);
    expect(check.companionSeatIds).toEqual([companion.id]);

    await ctx.seats.setTaken(event.id, { [wheelchair.id]: 'S' }); // sold earlier
    check = await validateSelection(ctx, sid, strict);
    expect(check.ok).toBe(true);
    expect(check.companionOwnerCheckSeatIds).toEqual([companion.id]);

    await ctx.seats.setTaken(event.id, { [wheelchair.id]: null });
    await discardCart(ctx, sid);
    const current = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
    const restored = await saveSeatMapDocument(
      handle.db,
      event.seatMapId!,
      { ...doc, version: current.version },
      null,
    );
    expect(restored.ok).toBe(true);
    if (restored.ok) await afterSeatMapSaved(ctx, restored);
  });

  it('enforces per-order limits of categories, tariffs and access codes', async () => {
    const refresh = async () =>
      invalidatePublicSeatMap(ctx, event.id, await seatMapVersion(ctx, event.seatMapId!));
    const freeSeats = async (sid: string) => {
      const availability = await getAvailability(ctx, sid, event);
      const busy = new Set([...availability.locked, ...availability.taken]);
      const doc = (await loadSeatMapDocument(handle.db, event.seatMapId!))!;
      return doc.seats.filter((s) => s.blockReason === null && !busy.has(s.id));
    };
    // category limit 2
    await handle.db
      .update(priceCategories)
      .set({ maxTicketsPerOrder: 2 })
      .where(eq(priceCategories.id, categoryId));
    await refresh();
    const sid = `l${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, sid);
    const seats = await freeSeats(sid);
    await addSeats(ctx, sid, event, [seats[0]!.id, seats[1]!.id]);
    await expect(addSeats(ctx, sid, event, [seats[2]!.id])).rejects.toMatchObject({
      code: 'CATEGORY_LIMIT',
      details: { max: 2 },
    });

    // tariff limit 1 (chosen per seat in the cart)
    const [reduced] = await handle.db
      .update(ticketTypes)
      .set({ maxPerOrder: 1 })
      .where(and(eq(ticketTypes.eventId, event.id), eq(ticketTypes.name, 'Reduced')))
      .returning();
    await refresh();
    await setTariff(ctx, sid, event, seats[0]!.id, reduced!.id);
    await expect(setTariff(ctx, sid, event, seats[1]!.id, reduced!.id)).rejects.toMatchObject({
      code: 'TARIFF_LIMIT',
    });
    await discardCart(ctx, sid);

    // access code limited to 1 ticket per order
    await handle.db
      .update(priceCategories)
      .set({ maxTicketsPerOrder: null })
      .where(eq(priceCategories.id, categoryId));
    await handle.db
      .update(ticketTypes)
      .set({ maxPerOrder: null })
      .where(eq(ticketTypes.id, reduced!.id));
    await refresh();
    const [code] = await handle.db
      .insert(accessCodes)
      .values({
        eventId: event.id,
        code: `LIM${uuid().slice(0, 6).toUpperCase()}`,
        type: 'MULTI_USE',
        maxTicketsPerOrder: 1,
      })
      .returning();
    const vip = `v${uuid().slice(0, 8)}`;
    await enterShop(ctx, event, vip);
    await ctx.redis.set(ctx.keys.queueAccessCode(event.id, vip), code!.id);
    const vipSeats = await freeSeats(vip);
    await addSeats(ctx, vip, event, [vipSeats[0]!.id]);
    await expect(addSeats(ctx, vip, event, [vipSeats[1]!.id])).rejects.toMatchObject({
      code: 'TICKET_LIMIT',
    });
    await discardCart(ctx, vip);
    await handle.db.delete(accessCodes).where(eq(accessCodes.id, code!.id));
  });

  it('deletes archived events without orders (freeing the slug) and refuses events with orders', async () => {
    const [venue] = await handle.db
      .select({ id: seatMaps.venueId })
      .from(seatMaps)
      .where(eq(seatMaps.id, templateId));
    const [tax] = await handle.db.select().from(taxRates).limit(1);
    const mapId = await handle.db.transaction((tx) =>
      cloneSeatMap(tx, templateId, { kind: 'EVENT', name: 'Old show' }),
    );
    const slug = `old-show-${uuid().slice(0, 6)}`;
    const [old] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: mapId,
        slug,
        title: 'Old show',
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() - 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
      })
      .returning();
    await expect(deleteArchivedEvent(ctx, old!.id)).rejects.toMatchObject({
      code: 'EVENT_NOT_ARCHIVED',
    });
    await handle.db.update(events).set({ status: 'ARCHIVED' }).where(eq(events.id, old!.id));
    await ctx.redis.set(ctx.keys.seatsTaken(old!.id), 'x');
    expect(await deleteArchivedEvent(ctx, old!.id)).toEqual({ slug, title: 'Old show' });
    expect(await handle.db.select().from(events).where(eq(events.slug, slug))).toHaveLength(0);
    expect(await handle.db.select().from(seatMaps).where(eq(seatMaps.id, mapId))).toHaveLength(0);
    expect(await ctx.redis.exists(ctx.keys.seatsTaken(old!.id))).toBe(0);

    // the main test event has (cancelled) order items from an earlier test → must be refused
    await handle.db.update(events).set({ status: 'ARCHIVED' }).where(eq(events.id, event.id));
    await expect(deleteArchivedEvent(ctx, event.id)).rejects.toMatchObject({
      code: 'EVENT_HAS_ORDERS',
    });
  });
});
