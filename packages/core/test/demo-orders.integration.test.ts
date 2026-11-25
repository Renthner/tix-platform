/**
 * Demo-data generator (`tix demo-orders`) against real PostgreSQL + Redis: regular (non-test)
 * orders through the shop / box-office paths, the scenario mix, the real-address assignment, the
 * ticket hand-over A -> B and the capacity cap.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  bankAccounts,
  createDb,
  emailMessages,
  events,
  loadRootEnv,
  orderItems,
  orders,
  priceCategories,
  priceCategoryTicketTypes,
  seatMaps,
  taxRates,
  tickets,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import type { SeatMapDocumentInput } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEMO_CAPACITY_SHARE,
  afterSeatMapSaved,
  createCoreContext,
  generateDemoOrders,
  saveSeatMapDocument,
  saveSetting,
  type CoreContext,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();

const ROWS = 5;
const SEATS_PER_ROW = 16;
const STANDING = 20;

describe.skipIf(!adminUrl || !redisUrl)('demo orders generator (integration)', () => {
  const dbName = `tix_demo_orders_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  const eventIds: string[] = [];
  let draftId: string;
  const jobs = { add: vi.fn(async () => undefined), close: async () => {} };

  async function createEvent(title: string, status: 'PUBLISHED' | 'DRAFT', taxRateId: string) {
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
    const [ev] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `${title.toLowerCase()}-${uuid().slice(0, 6)}`,
        title,
        status,
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId,
        orphanSeatRuleEnabled: true,
      })
      .returning();
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId: ev!.id, name: 'Cat 1', color: '#336699', basePrice: 3000 })
      .returning();
    const [normal] = await handle.db
      .insert(ticketTypes)
      .values({ eventId: ev!.id, name: 'Normal', isDefault: true })
      .returning();
    const [reduced] = await handle.db
      .insert(ticketTypes)
      .values({
        eventId: ev!.id,
        name: 'Reduced',
        discountKind: 'FIXED_AMOUNT',
        discountValue: 500,
        requiresProofAtEntry: true,
        scannerWarning: 'Check proof',
      })
      .returning();
    await handle.db.insert(priceCategoryTicketTypes).values([
      { priceCategoryId: category!.id, ticketTypeId: normal!.id },
      { priceCategoryId: category!.id, ticketTypeId: reduced!.id },
    ]);
    const sectionId = uuid();
    const standingId = uuid();
    const rows = Array.from({ length: ROWS }, (_, r) => ({
      id: uuid(),
      sectionId,
      label: String.fromCharCode(65 + r),
      sortOrder: r + 1,
      geometry: {
        curve: {
          type: 'straight' as const,
          start: { x: 20, y: 20 + r * 30 },
          end: { x: 20 + SEATS_PER_ROW * 30, y: 20 + r * 30 },
        },
        seatSpacing: 30,
      },
    }));
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
          geometry: { type: 'rect', x: 0, y: 0, width: 600, height: 120 },
        },
        {
          id: standingId,
          type: 'STANDING',
          name: 'Floor',
          ticketLabel: 'Floor',
          capacity: STANDING,
          priceCategoryId: category!.id,
          geometry: { type: 'rect', x: 0, y: 200, width: 400, height: 100 },
        },
      ],
      rows,
      seats: rows.flatMap((row, r) =>
        Array.from({ length: SEATS_PER_ROW }, (_, i) => ({
          id: uuid(),
          sectionId,
          rowId: row.id,
          label: String(i + 1),
          position: i + 1,
          x: 20 + i * 30,
          y: 20 + r * 30,
          priceCategoryId: category!.id,
        })),
      ),
    };
    const saved = await saveSeatMapDocument(handle.db, map!.id, doc, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) await afterSeatMapSaved(ctx, saved);
    return ev!.id;
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
    });
    await handle.db
      .insert(adminUsers)
      .values({ email: 'boss@example.invalid', displayName: 'Boss', roles: ['SUPER_ADMIN'] });
    const [tax] = await handle.db
      .insert(taxRates)
      .values({ name: `vat-${uuid().slice(0, 6)}`, rateBasisPoints: 700 })
      .returning();
    await handle.db.insert(bankAccounts).values({
      name: 'Main',
      accountHolder: 'Example Theatre e.V.',
      iban: 'DE89370400440532013000',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
    });
    eventIds.push(await createEvent('Gala', 'PUBLISHED', tax!.id));
    eventIds.push(await createEvent('Matinee', 'PUBLISHED', tax!.id));
    draftId = await createEvent('Draft', 'DRAFT', tax!.id);
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

  const ordersOf = (email: string) =>
    handle.db.select().from(orders).where(eq(orders.email, email));

  it('creates regular orders with the planned mix, real addresses and the hand-over A -> B', async () => {
    await saveSetting(ctx, 'ticketSelfService', { enabled: true, allowTransfer: true }, null);
    const [a, b, c] = ['real-a@example.net', 'real-b@example.net', 'real-c@example.net'];
    let planned = false;
    const result = await generateDemoOrders(ctx, {
      count: 20,
      real: [a, b, c],
      seed: 42,
      onPlan: (plan) => {
        planned = true;
        expect(plan.events.map((e) => e.id).sort()).toEqual([...eventIds].sort());
        expect(plan.skippedEvents).toEqual([]);
        expect(plan.boxOfficeUser).not.toBeNull();
        expect(Object.values(plan.mix).reduce((x, y) => x + y, 0)).toBe(20);
        expect(plan.mix.BOX_OFFICE).toBeGreaterThan(0);
        expect(plan.mix.MULTI_EVENT).toBeGreaterThan(0);
        expect(plan.real.map((r) => r.label)).toEqual(['A', 'B', 'C']);
        return true;
      },
    });
    expect(planned).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.orders).toHaveLength(20 + 6);

    const all = await handle.db.select().from(orders);
    expect(all).toHaveLength(result.orders.length);
    expect(all.every((o) => !o.isTest)).toBe(true);
    expect(all.some((o) => o.status === 'AWAITING_PAYMENT')).toBe(true);
    expect(all.some((o) => o.status === 'PAID' && o.channel === 'ONLINE')).toBe(true);
    const box = all.filter((o) => o.channel === 'BOX_OFFICE');
    expect(box.length).toBe(result.plan.mix.BOX_OFFICE);
    expect(box.every((o) => o.status === 'PAID' && o.email === null)).toBe(true);
    expect(new Set(box.map((o) => o.paymentMethod)).size).toBeGreaterThan(1);

    // Real addresses: A = unpaid + paid + multi-event paid, B = paid, C = paid + unpaid.
    const ordersA = await ordersOf(a);
    expect(ordersA.map((o) => o.status).sort()).toEqual(['AWAITING_PAYMENT', 'PAID', 'PAID']);
    const multi = result.orders.find((o) => o.real === 'A' && o.scenario === 'MULTI_EVENT')!;
    const multiItems = await handle.db
      .select({ eventId: orderItems.eventId })
      .from(orderItems)
      .where(eq(orderItems.orderId, multi.orderId));
    expect(new Set(multiItems.map((i) => i.eventId)).size).toBe(2);
    expect((await ordersOf(b)).map((o) => o.status)).toEqual(['PAID']);
    expect((await ordersOf(c)).map((o) => o.status).sort()).toEqual(['AWAITING_PAYMENT', 'PAID']);

    expect(result.transfer).toMatchObject({ status: 'DONE', to: b });
    const held = await handle.db.select().from(tickets).where(eq(tickets.holderEmail, b));
    expect(held).toHaveLength(1);
    expect(held[0]!.status).toBe('VALID');
    expect(ordersA.map((o) => o.id)).toContain(held[0]!.orderId);

    // Draft events are never touched; the capacity share holds; no cart lock is left behind.
    const draftItems = await handle.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.eventId, draftId));
    expect(draftItems).toHaveLength(0);
    const capacity = ROWS * SEATS_PER_ROW + STANDING;
    for (const id of eventIds) {
      const items = await handle.db
        .select()
        .from(orderItems)
        .where(inArray(orderItems.eventId, [id]));
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(Math.floor(capacity * DEMO_CAPACITY_SHARE));
      expect(await ctx.seats.lockedSeatIds(id)).toEqual([]);
    }
    // Follow-up work goes to the worker's queues exactly like from the web app, and every online
    // order has its outbox mail (whatever its delivery status).
    const paidOnline = result.orders.find(
      (o) => o.status === 'PAID' && o.method === 'BANK_TRANSFER',
    )!;
    expect(jobs.add).toHaveBeenCalledWith(
      'documents',
      'order-paid',
      expect.objectContaining({ orderId: paidOnline.orderId }),
      expect.anything(),
    );
    const online = all.filter((o) => o.channel === 'ONLINE').map((o) => o.id);
    const mails = await handle.db
      .select({ orderId: emailMessages.orderId })
      .from(emailMessages)
      .where(inArray(emailMessages.orderId, online));
    expect(new Set(mails.map((m) => m.orderId)).size).toBe(online.length);
  });

  it('skips the hand-over with a note when ticket self-service is off', async () => {
    await saveSetting(ctx, 'ticketSelfService', { enabled: false }, null);
    const result = await generateDemoOrders(ctx, {
      count: 2,
      real: ['solo-a@example.net', 'solo-b@example.net'],
      seed: 7,
    });
    expect(result.failures).toEqual([]);
    expect(result.transfer).toMatchObject({ status: 'SKIPPED' });
    expect(result.notes.some((n) => n.includes('hand-over A -> B skipped'))).toBe(true);
    const held = await handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.holderEmail, 'solo-b@example.net'));
    expect(held).toHaveLength(0);
  });

  it('aborts before creating anything when the plan is declined', async () => {
    const before = (await handle.db.select({ id: orders.id }).from(orders)).length;
    const result = await generateDemoOrders(ctx, { count: 5, seed: 1, onPlan: () => false });
    expect(result.aborted).toBe(true);
    expect(result.orders).toEqual([]);
    expect((await handle.db.select({ id: orders.id }).from(orders)).length).toBe(before);
  });
});
