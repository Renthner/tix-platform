/**
 * Events without a seating plan (admission-only) against real PostgreSQL + Redis: schema checks,
 * venue-less events, contingent CRUD with the Redis inventory, publish validation, a GA purchase
 * from a contingent, `changeEventSeating` (DRAFT only, refused with orders) and venue-less events
 * in the converted listings.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  bankAccounts,
  createDb,
  events,
  loadRootEnv,
  priceCategories,
  priceCategoryTicketTypes,
  seatMapSections,
  seatMaps,
  taxRates,
  tickets,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { checkoutInputSchema } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  changeEventSeating,
  changeEventStatus,
  changeOrderSeats,
  createBoxOfficeOrder,
  createCoreContext,
  duplicateEvent,
  enterShop,
  exportEvent,
  importEvent,
  loadOrderDocumentData,
  getEventById,
  getEventWithVenueBySlug,
  getOrderView,
  getShopEventList,
  holderTicketVariables,
  insertEmptyEventSeatMap,
  invalidateShopCache,
  listContingents,
  loadCalendarEvents,
  placeOrder,
  INVENTORY_REBUILD_JOB,
  inventoryRebuildJobId,
  rebuildInventory,
  reconcileEventInventory,
  removeContingent,
  replaceEventSeatPlan,
  saveContingent,
  saveSeatMapDocument,
  setGeneralAdmission,
  type CoreContext,
  type JobQueues,
  type ObjectStorage,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('admission-only events (integration)', () => {
  const dbName = `tix_seating_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let taxId: string;
  let venueId: string;
  let otherVenueId: string;
  let templateId: string;
  const jobs = { add: vi.fn(async () => undefined), close: async () => {} };
  // In-memory object storage (event import needs the capability; never the shared MinIO).
  const stored = new Map<string, Uint8Array>();
  const storage = {
    put: async (_bucket: string, key: string, body: Uint8Array | string) => {
      stored.set(key, typeof body === 'string' ? Buffer.from(body) : body);
    },
    get: async (_bucket: string, key: string) => ({
      body: stored.get(key)!,
      contentType: undefined,
    }),
    delete: async (_bucket: string, key: string) => {
      stored.delete(key);
    },
  } as unknown as ObjectStorage;
  const sid = () => `k${uuid().slice(0, 8)}`;

  const buyer = (expectedTotalGross: number) =>
    checkoutInputSchema.parse({
      method: 'BANK_TRANSFER',
      email: 'fair@example.invalid',
      firstName: 'Erika',
      lastName: 'Example',
      phone: '+49 6134 123456',
      address: { street: 'Hauptstrasse 1', postalCode: '65462', city: 'Town', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross,
      locale: 'de',
    });

  /** Event with an offered price category (20 €); mode ADMISSION = hidden plan without venue. */
  async function createEvent(opts: {
    mode: 'SEATED' | 'ADMISSION';
    venueId: string | null;
    status?: 'DRAFT' | 'PUBLISHED';
  }) {
    const db = handle.db;
    const slug = `ev-${uuid().slice(0, 8)}`;
    const seatMapId = await insertEmptyEventSeatMap(db, {
      venueId: opts.mode === 'ADMISSION' ? null : opts.venueId,
      name: slug,
    });
    const [ev] = await db
      .insert(events)
      .values({
        venueId: opts.venueId,
        seatingMode: opts.mode,
        seatMapId,
        slug,
        title: `Fair ${slug}`,
        status: opts.status ?? 'DRAFT',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: taxId,
      })
      .returning();
    const [category] = await db
      .insert(priceCategories)
      .values({ eventId: ev!.id, name: 'Admission', color: '#336699', basePrice: 2000 })
      .returning();
    const [normal] = await db
      .insert(ticketTypes)
      .values({ eventId: ev!.id, name: 'Normal', isDefault: true })
      .returning();
    await db
      .insert(priceCategoryTicketTypes)
      .values({ priceCategoryId: category!.id, ticketTypeId: normal!.id });
    return { id: ev!.id, slug, seatMapId, categoryId: category!.id };
  }

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
      storage,
    });
    const db = handle.db;
    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    venueId = venue!.id;
    const [other] = await db
      .insert(venues)
      .values({ name: 'Other', slug: `other-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    otherVenueId = other!.id;
    const [template] = await db
      .insert(seatMaps)
      .values({
        venueId,
        kind: 'TEMPLATE',
        name: 'Master',
        canvasWidth: 800,
        canvasHeight: 600,
      })
      .returning();
    templateId = template!.id;
    const [tax] = await db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 700 })
      .returning();
    taxId = tax!.id;
    await db.insert(bankAccounts).values({
      name: 'Main',
      accountHolder: 'Example e.V.',
      iban: 'DE89370400440532013000',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
    });
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

  it('enforces the venue rules in the schema', async () => {
    const db = handle.db;
    // Seated events and master plans need a venue; the hidden admission plan has none.
    const mapId = await insertEmptyEventSeatMap(db, { venueId: null, name: 'x' });
    await expect(
      db.insert(events).values({
        venueId: null,
        seatMapId: mapId,
        slug: `bad-${uuid().slice(0, 6)}`,
        title: 'Bad',
        startsAt: new Date(Date.now() + 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: taxId,
      }),
    ).rejects.toMatchObject({ cause: { constraint: 'events_seated_has_venue' } });
    await expect(
      db.insert(seatMaps).values({
        venueId: null,
        kind: 'TEMPLATE',
        name: 'No venue',
        canvasWidth: 10,
        canvasHeight: 10,
      }),
    ).rejects.toMatchObject({ cause: { constraint: 'seat_maps_template_has_venue' } });
    await db.delete(seatMaps).where(eq(seatMaps.id, mapId));
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row).toMatchObject({ venueId: null, seatingMode: 'ADMISSION' });
  });

  it('publishes an admission event only with a sellable contingent', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    await expect(
      changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' }),
    ).rejects.toMatchObject({ code: 'ADMISSION_NOT_SELLABLE' });
    // A contingent without capacity is not sellable either.
    const empty = await saveContingent(ctx, ev.id, {
      name: 'Admission',
      capacity: 0,
      priceCategoryId: ev.categoryId,
    });
    await expect(
      changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' }),
    ).rejects.toMatchObject({ code: 'ADMISSION_NOT_SELLABLE' });
    await saveContingent(ctx, ev.id, {
      id: empty.id,
      name: 'Admission',
      capacity: 10,
      priceCategoryId: ev.categoryId,
    });
    await expect(
      changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' }),
    ).resolves.toMatchObject({ from: 'DRAFT' });
    // Seated events keep the old rules (no contingent check in the core).
    const seated = await createEvent({ mode: 'SEATED', venueId });
    await expect(
      changeEventStatus(ctx, { eventId: seated.id, status: 'PUBLISHED' }),
    ).resolves.toMatchObject({ from: 'DRAFT' });
  });

  it('manages contingents with the Redis inventory and refuses seat-plan tools', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    const [before] = await handle.db
      .select({ version: seatMaps.version })
      .from(seatMaps)
      .where(eq(seatMaps.id, ev.seatMapId));
    const a = await saveContingent(ctx, ev.id, {
      name: 'Day ticket',
      capacity: 50,
      priceCategoryId: ev.categoryId,
    });
    expect(a.version).toBe(before!.version + 1);
    expect(await ctx.seats.generalAdmissionOpen(ev.id)).toEqual({ [a.id]: 50 });
    const [section] = await handle.db
      .select()
      .from(seatMapSections)
      .where(eq(seatMapSections.id, a.id));
    expect(section).toMatchObject({ type: 'STANDING', ticketLabel: 'Day ticket', capacity: 50 });

    await expect(
      saveContingent(ctx, ev.id, {
        name: 'Day ticket',
        capacity: 5,
        priceCategoryId: ev.categoryId,
      }),
    ).rejects.toMatchObject({ code: 'CONTINGENT_NAME_TAKEN' });
    await expect(
      saveContingent(ctx, ev.id, { name: 'X', capacity: 5, priceCategoryId: uuid() }),
    ).rejects.toMatchObject({ code: 'PRICE_CATEGORY_NOT_FOUND' });

    const b = await saveContingent(ctx, ev.id, {
      name: 'Weekend',
      capacity: 20,
      priceCategoryId: ev.categoryId,
    });
    const overview = await listContingents(ctx, ev.id);
    expect(overview.contingents.map((c) => c.name)).toEqual(['Day ticket', 'Weekend']);
    await expect(removeContingent(ctx, ev.id, b.id)).resolves.toEqual({ softRemoved: false });
    expect(await ctx.seats.generalAdmissionOpen(ev.id)).toEqual({ [a.id]: 50 });

    // Seat editor, plan replacement and contingents on seated events are refused.
    const [current] = await handle.db
      .select({ version: seatMaps.version })
      .from(seatMaps)
      .where(eq(seatMaps.id, ev.seatMapId));
    const saved = await saveSeatMapDocument(
      handle.db,
      ev.seatMapId,
      { version: current!.version, name: 'x', canvasWidth: 100, canvasHeight: 100 },
      null,
    );
    expect(saved).toMatchObject({
      ok: false,
      status: 409,
      error: { code: 'EVENT_ADMISSION_ONLY' },
    });
    await expect(
      replaceEventSeatPlan(ctx, {
        eventId: ev.id,
        source: { kind: 'template', seatMapId: templateId },
        userId: null,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_ADMISSION_ONLY' });
    const seated = await createEvent({ mode: 'SEATED', venueId });
    await expect(
      saveContingent(ctx, seated.id, {
        name: 'X',
        capacity: 1,
        priceCategoryId: seated.categoryId,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_ADMISSION' });
  });

  it('sells a contingent and never lets its capacity drop below sold + held', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    const c = await saveContingent(ctx, ev.id, {
      name: 'Admission',
      capacity: 3,
      priceCategoryId: ev.categoryId,
    });
    await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' });
    const event = await getEventById(ctx, ev.id);

    const session = sid();
    await enterShop(ctx, event, session);
    await setGeneralAdmission(ctx, session, event, c.id, 2);
    const placed = await placeOrder(ctx, { sessionId: session, input: buyer(4000) });
    expect(placed.status).toBe('AWAITING_PAYMENT');
    const [section] = await handle.db
      .select({ allocated: seatMapSections.allocatedCount })
      .from(seatMapSections)
      .where(eq(seatMapSections.id, c.id));
    expect(section!.allocated).toBe(2);

    // Another cart holds the last spot.
    const other = sid();
    await enterShop(ctx, event, other);
    await setGeneralAdmission(ctx, other, event, c.id, 1);
    await expect(
      saveContingent(ctx, ev.id, {
        id: c.id,
        name: 'Admission',
        capacity: 2,
        priceCategoryId: ev.categoryId,
      }),
    ).rejects.toMatchObject({
      code: 'CONTINGENT_CAPACITY_TOO_LOW',
      details: { minimum: 3, allocated: 2, held: 1 },
    });
    await expect(removeContingent(ctx, ev.id, c.id)).rejects.toMatchObject({
      code: 'CONTINGENT_IN_USE',
    });
    await setGeneralAdmission(ctx, other, event, c.id, 0);
    await saveContingent(ctx, ev.id, {
      id: c.id,
      name: 'Admission',
      capacity: 2,
      priceCategoryId: ev.categoryId,
    });
    // Sold out after shrinking to the sold spots.
    expect(await ctx.seats.generalAdmissionOpen(ev.id)).toEqual({ [c.id]: 0 });

    // The order and its venue-less event render without a venue.
    const view = await getOrderView(ctx, placed.orderId);
    expect(view?.events).toMatchObject([{ eventId: ev.id, venueName: '' }]);
    const [calendar] = await loadCalendarEvents(ctx, [ev.id], 'de');
    expect(calendar).toMatchObject({ id: ev.id, location: null, directionsUrl: null });

    // Published + orders: the seating can no longer change …
    await expect(
      changeEventSeating(ctx, {
        eventId: ev.id,
        mode: 'SEATED',
        venueId,
        templateId: null,
        userId: null,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_DRAFT' });
    // … and back in DRAFT the (test) orders still block it.
    await handle.db.update(events).set({ status: 'DRAFT' }).where(eq(events.id, ev.id));
    await expect(
      changeEventSeating(ctx, {
        eventId: ev.id,
        mode: 'SEATED',
        venueId,
        templateId: null,
        userId: null,
      }),
    ).rejects.toMatchObject({ code: 'SEAT_PLAN_IN_USE' });
  });

  it('refuses a price category change while spots are sold or held', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    const [other] = await handle.db
      .insert(priceCategories)
      .values({ eventId: ev.id, name: 'Other', color: '#993366', basePrice: 3000 })
      .returning();
    const c = await saveContingent(ctx, ev.id, {
      name: 'Admission',
      capacity: 5,
      priceCategoryId: ev.categoryId,
    });
    await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' });
    const event = await getEventById(ctx, ev.id);
    const change = (priceCategoryId: string, capacity = 5) =>
      saveContingent(ctx, ev.id, { id: c.id, name: 'Admission', capacity, priceCategoryId });

    // Held in a cart: no category change (other fields still editable).
    const session = sid();
    await enterShop(ctx, event, session);
    await setGeneralAdmission(ctx, session, event, c.id, 1);
    await expect(change(other!.id)).rejects.toMatchObject({
      code: 'CONTINGENT_CATEGORY_IN_USE',
      details: { allocated: 0, held: 1 },
    });
    await expect(change(ev.categoryId, 6)).resolves.toMatchObject({ id: c.id, created: false });
    // Sold: still refused.
    await placeOrder(ctx, { sessionId: session, input: buyer(2000) });
    await expect(change(other!.id, 6)).rejects.toMatchObject({
      code: 'CONTINGENT_CATEGORY_IN_USE',
      details: { allocated: 1, held: 0 },
    });
    const [row] = await handle.db
      .select({ priceCategoryId: seatMapSections.priceCategoryId })
      .from(seatMapSections)
      .where(eq(seatMapSections.id, c.id));
    expect(row!.priceCategoryId).toBe(ev.categoryId);

    // Nothing sold or held: the category can change.
    const fresh = await saveContingent(ctx, ev.id, {
      name: 'Late',
      capacity: 3,
      priceCategoryId: ev.categoryId,
    });
    await expect(
      saveContingent(ctx, ev.id, {
        id: fresh.id,
        name: 'Late',
        capacity: 3,
        priceCategoryId: other!.id,
      }),
    ).resolves.toMatchObject({ id: fresh.id });
  });

  it('writes the audit entry inside the contingent transaction', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    const seen: { created: boolean; inTx: boolean }[] = [];
    const saved = await saveContingent(
      ctx,
      ev.id,
      { name: 'Audited', capacity: 4, priceCategoryId: ev.categoryId },
      {
        audit: async (tx, r) => {
          // The new row is visible inside the transaction that will commit it.
          const [own] = await tx
            .select({ id: seatMapSections.id })
            .from(seatMapSections)
            .where(eq(seatMapSections.id, r.id));
          seen.push({ created: r.created, inTx: !!own });
        },
      },
    );
    expect(seen).toEqual([{ created: true, inTx: true }]);
    // A failing audit rolls the change back.
    await expect(
      saveContingent(
        ctx,
        ev.id,
        { name: 'Rolled back', capacity: 4, priceCategoryId: ev.categoryId },
        {
          audit: async () => {
            throw new Error('audit failed');
          },
        },
      ),
    ).rejects.toThrow('audit failed');
    await expect(
      removeContingent(ctx, ev.id, saved.id, {
        audit: async () => {
          throw new Error('audit failed');
        },
      }),
    ).rejects.toThrow('audit failed');
    const overview = await listContingents(ctx, ev.id);
    expect(overview.contingents.map((x) => x.name)).toEqual(['Audited']);
    const removed: boolean[] = [];
    await removeContingent(ctx, ev.id, saved.id, {
      audit: async (_tx, r) => {
        removed.push(r.softRemoved);
      },
    });
    expect(removed).toEqual([false]);
  });

  it('repairs a standing-capacity drift with the delayed inventory rebuild', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    jobs.add.mockClear();
    const c = await saveContingent(ctx, ev.id, {
      name: 'Admission',
      capacity: 10,
      priceCategoryId: ev.categoryId,
    });
    // Every contingent save queues one delayed rebuild per plan version.
    expect(jobs.add).toHaveBeenCalledWith(
      'seat-locks',
      INVENTORY_REBUILD_JOB,
      { eventId: ev.id },
      expect.objectContaining({ jobId: inventoryRebuildJobId(ev.id, c.version), delay: 5_000 }),
    );
    await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' });
    const event = await getEventById(ctx, ev.id);
    const open = async () => (await ctx.seats.generalAdmissionOpen(ev.id))[c.id];
    const allocate = (n: number) =>
      handle.db
        .update(seatMapSections)
        .set({ allocatedCount: sql`${seatMapSections.allocatedCount} + ${n}` })
        .where(eq(seatMapSections.id, c.id));

    // A bystander cart holds one spot the whole time (holds are never touched by a rebuild).
    const bystander = sid();
    await enterShop(ctx, event, bystander);
    await setGeneralAdmission(ctx, bystander, event, c.id, 1);

    // Too low: checkout claims 3 in PostgreSQL, a contingent save rebuilds the mirror from the
    // DB before the checkout's post-commit `commitGeneralAdmission` - the 3 are applied twice.
    const buyerSession = sid();
    await enterShop(ctx, event, buyerSession);
    await setGeneralAdmission(ctx, buyerSession, event, c.id, 3);
    await allocate(3);
    await rebuildInventory(ctx, event);
    expect(await ctx.seats.commitGeneralAdmission(ev.id, buyerSession, { [c.id]: 3 })).toBe(true);
    expect(await open()).toBe(4);
    await expect(reconcileEventInventory(ctx, ev.id)).resolves.toBe(true);
    expect(await open()).toBe(7);
    expect(await ctx.seats.generalAdmissionHeldBySection(ev.id)).toEqual({ [c.id]: 1 });
    expect((await ctx.seats.generalAdmissionRemaining(ev.id))[c.id]).toBe(6);

    // Too high: a cancellation releases 2 in PostgreSQL, the rebuild reads the released state,
    // then the release's `releaseGeneralAdmission` adds the 2 again.
    await allocate(-2);
    await rebuildInventory(ctx, event);
    await ctx.seats.releaseGeneralAdmission(ev.id, { [c.id]: 2 });
    expect(await open()).toBe(11);
    await reconcileEventInventory(ctx, ev.id);
    expect(await open()).toBe(9);
    expect((await ctx.seats.generalAdmissionRemaining(ev.id))[c.id]).toBe(8);

    // A deleted event is a no-op (the job must not retry forever).
    await expect(reconcileEventInventory(ctx, uuid())).resolves.toBe(false);
  });

  it('changes seating mode, venue and plan of a draft in one path', async () => {
    const ev = await createEvent({ mode: 'SEATED', venueId });
    // Seated without venue / template of another venue / template on admission are refused.
    await expect(
      changeEventSeating(ctx, {
        eventId: ev.id,
        mode: 'SEATED',
        venueId: null,
        templateId: null,
        userId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      changeEventSeating(ctx, {
        eventId: ev.id,
        mode: 'SEATED',
        venueId: otherVenueId,
        templateId,
        userId: null,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_MISMATCH' });
    await expect(
      changeEventSeating(ctx, {
        eventId: ev.id,
        mode: 'ADMISSION',
        venueId: null,
        templateId,
        userId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const audit = vi.fn(async () => {});
    const toAdmission = await changeEventSeating(ctx, {
      eventId: ev.id,
      mode: 'ADMISSION',
      venueId: null,
      templateId: null,
      userId: null,
      audit,
    });
    expect(audit).toHaveBeenCalledOnce();
    expect(toAdmission).toMatchObject({ mode: 'ADMISSION', venueId: null });
    const [row] = await handle.db.select().from(events).where(eq(events.id, ev.id));
    expect(row).toMatchObject({
      seatingMode: 'ADMISSION',
      venueId: null,
      seatMapId: toAdmission.seatMapId,
    });
    const maps = await handle.db
      .select({ id: seatMaps.id, venueId: seatMaps.venueId, version: seatMaps.version })
      .from(seatMaps)
      .where(eq(seatMaps.id, ev.seatMapId));
    expect(maps).toHaveLength(0);
    const [hidden] = await handle.db
      .select({ venueId: seatMaps.venueId, version: seatMaps.version })
      .from(seatMaps)
      .where(eq(seatMaps.id, toAdmission.seatMapId));
    expect(hidden).toMatchObject({ venueId: null, version: 2 });

    // A contingent added, then the event goes back to a seated plan copy: Redis drops it.
    const c = await saveContingent(ctx, ev.id, {
      name: 'Admission',
      capacity: 5,
      priceCategoryId: ev.categoryId,
    });
    expect(await ctx.seats.generalAdmissionOpen(ev.id)).toEqual({ [c.id]: 5 });
    const toSeated = await changeEventSeating(ctx, {
      eventId: ev.id,
      mode: 'SEATED',
      venueId,
      templateId,
      userId: null,
    });
    const [seatedRow] = await handle.db.select().from(events).where(eq(events.id, ev.id));
    expect(seatedRow).toMatchObject({ seatingMode: 'SEATED', venueId });
    const [copy] = await handle.db
      .select({ venueId: seatMaps.venueId, clonedFromId: seatMaps.clonedFromId })
      .from(seatMaps)
      .where(eq(seatMaps.id, toSeated.seatMapId));
    expect(copy).toMatchObject({ venueId, clonedFromId: templateId });
    expect(await ctx.seats.generalAdmissionOpen(ev.id)).toEqual({});

    // A venue no seated event uses can be deleted (admission plans never reference one).
    const extra = await createEvent({ mode: 'ADMISSION', venueId: otherVenueId });
    await changeEventSeating(ctx, {
      eventId: extra.id,
      mode: 'ADMISSION',
      venueId: null,
      templateId: null,
      userId: null,
    });
    await expect(
      handle.db.delete(venues).where(eq(venues.id, otherVenueId)),
    ).resolves.toBeDefined();
  });

  it('duplicates a venue-less admission event with its contingents', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    await saveContingent(ctx, ev.id, {
      name: 'Admission',
      capacity: 7,
      priceCategoryId: ev.categoryId,
    });
    const { eventId } = await duplicateEvent(ctx, {
      sourceEventId: ev.id,
      userId: null as never,
      title: 'Fair copy',
      startsAt: new Date(Date.now() + 60 * 86_400_000),
    });
    const [copy] = await handle.db.select().from(events).where(eq(events.id, eventId));
    expect(copy).toMatchObject({ seatingMode: 'ADMISSION', venueId: null, status: 'DRAFT' });
    const [map] = await handle.db
      .select({ venueId: seatMaps.venueId })
      .from(seatMaps)
      .where(eq(seatMaps.id, copy!.seatMapId!));
    expect(map).toMatchObject({ venueId: null });
    const overview = await listContingents(ctx, eventId);
    expect(overview.contingents).toMatchObject([{ name: 'Admission', capacity: 7, allocated: 0 }]);
  });

  it('lists venue-less events in the converted listings', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    await saveContingent(ctx, ev.id, {
      name: 'Admission',
      capacity: 5,
      priceCategoryId: ev.categoryId,
    });
    await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' });
    await invalidateShopCache(ctx, 'all');
    const list = await getShopEventList(ctx);
    expect(list.find((r) => r.event.id === ev.id)).toMatchObject({ venue: null });
    const bySlug = await getEventWithVenueBySlug(ctx, ev.slug);
    expect(bySlug).toMatchObject({ event: { id: ev.id }, venue: null });
  });

  it('exports and imports an admission event with its contingents (venue optional)', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    await saveContingent(ctx, ev.id, {
      name: 'Day ticket',
      capacity: 40,
      priceCategoryId: ev.categoryId,
    });
    await saveContingent(ctx, ev.id, {
      name: 'Weekend',
      capacity: 15,
      priceCategoryId: ev.categoryId,
    });
    const file = await exportEvent(ctx, ev.id);
    expect(file.event.seatingMode).toBe('ADMISSION');
    expect(file.source.venueName).toBeNull();
    expect(file.seatPlan?.plan.sections.map((s) => [s.type, s.name, s.capacity])).toEqual([
      ['STANDING', 'Day ticket', 40],
      ['STANDING', 'Weekend', 15],
    ]);

    const importOptions = {
      userId: null,
      sanitizeRichText: (html: string) => html,
      defaultTicketTypeName: 'Standard',
    };
    // Without a venue.
    const imported = await importEvent(ctx, { ...importOptions, file, venueId: null });
    const [row] = await handle.db.select().from(events).where(eq(events.id, imported.eventId));
    expect(row).toMatchObject({ seatingMode: 'ADMISSION', venueId: null, status: 'DRAFT' });
    const [map] = await handle.db
      .select({ venueId: seatMaps.venueId })
      .from(seatMaps)
      .where(eq(seatMaps.id, row!.seatMapId!));
    expect(map).toMatchObject({ venueId: null });
    const overview = await listContingents(ctx, imported.eventId);
    expect(overview.contingents.map((c) => [c.name, c.capacity, c.allocated])).toEqual([
      ['Day ticket', 40, 0],
      ['Weekend', 15, 0],
    ]);
    // The imported contingents point at the imported (name-matched) price category.
    const [category] = await handle.db
      .select({ id: priceCategories.id })
      .from(priceCategories)
      .where(eq(priceCategories.eventId, imported.eventId));
    expect(overview.contingents.every((c) => c.priceCategoryId === category!.id)).toBe(true);
    // It can be published straight away and edited like any contingent.
    await expect(
      changeEventStatus(ctx, { eventId: imported.eventId, status: 'PUBLISHED' }),
    ).resolves.toMatchObject({ from: 'DRAFT' });

    // With a venue: the event gets it, the hidden plan still has none.
    const withVenue = await importEvent(ctx, { ...importOptions, file, venueId });
    const [venueRow] = await handle.db
      .select()
      .from(events)
      .where(eq(events.id, withVenue.eventId));
    expect(venueRow).toMatchObject({ seatingMode: 'ADMISSION', venueId });
    const [venueMap] = await handle.db
      .select({ venueId: seatMaps.venueId })
      .from(seatMaps)
      .where(eq(seatMaps.id, venueRow!.seatMapId!));
    expect(venueMap).toMatchObject({ venueId: null });

    // Without any contingent the file has no plan rows; the import still creates the hidden plan.
    const bare = await createEvent({ mode: 'ADMISSION', venueId: null });
    const bareImport = await importEvent(ctx, {
      ...importOptions,
      file: { ...(await exportEvent(ctx, bare.id)), seatPlan: null },
      venueId: null,
    });
    await expect(listContingents(ctx, bareImport.eventId)).resolves.toMatchObject({
      contingents: [],
    });

    // A file with seats cannot become an admission event.
    const seatedFile = structuredClone(file);
    seatedFile.seatPlan!.plan.sections[0]!.type = 'SEATED';
    await expect(
      importEvent(ctx, { ...importOptions, file: seatedFile, venueId: null }),
    ).rejects.toMatchObject({ code: 'EVENT_FILE_INVALID' });

    // Older files carry no seating mode: they import as SEATED and need a venue.
    const seated = await createEvent({ mode: 'SEATED', venueId });
    const legacy = structuredClone(await exportEvent(ctx, seated.id)) as {
      event: Record<string, unknown>;
    };
    delete legacy.event.seatingMode;
    await expect(
      importEvent(ctx, { ...importOptions, file: legacy, venueId: null }),
    ).rejects.toMatchObject({ code: 'VENUE_REQUIRED' });
    const legacyImport = await importEvent(ctx, { ...importOptions, file: legacy, venueId });
    const [legacyRow] = await handle.db
      .select()
      .from(events)
      .where(eq(events.id, legacyImport.eventId));
    expect(legacyRow).toMatchObject({ seatingMode: 'SEATED', venueId });
  });

  it('labels admission tickets and refuses a seat change for them', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    const c = await saveContingent(ctx, ev.id, {
      name: 'Day ticket',
      capacity: 10,
      priceCategoryId: ev.categoryId,
    });
    await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' });
    const event = await getEventById(ctx, ev.id);
    const session = sid();
    await enterShop(ctx, event, session);
    await setGeneralAdmission(ctx, session, event, c.id, 2);
    const placed = await placeOrder(ctx, { sessionId: session, input: buyer(4000) });

    const view = await getOrderView(ctx, placed.orderId);
    expect(view?.events).toMatchObject([
      {
        admission: true,
        venueName: '',
        items: [
          {
            kind: 'GENERAL_ADMISSION',
            sectionLabel: 'Day ticket',
            rowLabel: null,
            seatLabel: null,
          },
          {
            kind: 'GENERAL_ADMISSION',
            sectionLabel: 'Day ticket',
            rowLabel: null,
            seatLabel: null,
          },
        ],
      },
    ]);
    const docs = await loadOrderDocumentData(handle.db, placed.orderId);
    expect(docs?.events).toMatchObject([{ venueName: '', admission: true }]);

    const userId = uuid();
    await expect(
      changeOrderSeats(ctx, {
        orderId: placed.orderId,
        userId,
        holdSessionId: `boxoffice:${userId}:tab`,
        notify: false,
        changes: [{ orderItemId: view!.events[0]!.items[0]!.id, newSeatId: uuid() }],
      }),
    ).rejects.toMatchObject({ code: 'ITEM_ADMISSION_ONLY' });
  });

  it('sells contingent spots at the box office', async () => {
    const ev = await createEvent({ mode: 'ADMISSION', venueId: null });
    const c = await saveContingent(ctx, ev.id, {
      name: 'Evening',
      capacity: 3,
      priceCategoryId: ev.categoryId,
    });
    await changeEventStatus(ctx, { eventId: ev.id, status: 'PUBLISHED' });
    const [normal] = await handle.db
      .select({ id: ticketTypes.id })
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, ev.id));
    const [user] = await handle.db
      .insert(adminUsers)
      .values({
        email: `door-${uuid().slice(0, 6)}@example.invalid`,
        displayName: 'Door',
        roles: ['DOOR_STAFF'],
      })
      .returning();
    const sell = (quantity: number) =>
      createBoxOfficeOrder(ctx, {
        userId: user!.id,
        channel: 'BOX_OFFICE',
        lines: [{ eventId: ev.id, sectionId: c.id, quantity, ticketTypeId: normal!.id }],
        payment: 'CASH',
        sendEmail: false,
      });

    const sold = await sell(2);
    expect(sold).toMatchObject({ status: 'PAID', payment: 'CASH', ticketCount: 2 });
    const [section] = await handle.db
      .select({ allocated: seatMapSections.allocatedCount })
      .from(seatMapSections)
      .where(eq(seatMapSections.id, c.id));
    expect(section!.allocated).toBe(2);
    expect(await ctx.seats.generalAdmissionOpen(ev.id)).toEqual({ [c.id]: 1 });
    await expect(sell(2)).rejects.toMatchObject({ code: 'SECTION_SOLD_OUT' });

    const view = await getOrderView(ctx, sold.orderId);
    expect(view?.events).toMatchObject([
      {
        admission: true,
        items: [
          { kind: 'GENERAL_ADMISSION', sectionLabel: 'Evening', seatLabel: null },
          { kind: 'GENERAL_ADMISSION', sectionLabel: 'Evening', seatLabel: null },
        ],
      },
    ]);
    const issued = await handle.db.select().from(tickets).where(eq(tickets.orderId, sold.orderId));
    expect(issued).toHaveLength(2);

    // Holder mails say "Your ticket" (not "Your seat") for admission tickets.
    const vars = await holderTicketVariables(
      ctx,
      handle.db,
      { id: issued[0]!.id },
      { locale: 'en', isTest: false },
      { links: false },
    );
    expect(vars).toMatchObject({ ticketWithoutSeat: 'yes', eventVenue: '' });
    expect(vars.ticketPlace).toContain('Evening');
  });
});
