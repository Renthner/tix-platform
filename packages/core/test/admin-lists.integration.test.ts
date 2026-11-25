/**
 * Admin order list (sort, date range, open filter), bulk order actions and the web door desk against
 * real PostgreSQL + Redis (throw-away database, own key prefix).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminUsers,
  checkInLogs,
  createDb,
  events,
  loadRootEnv,
  orderHistory,
  orders,
  seatMapSections,
  seatMaps,
  taxRates,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  ensureWebDoorDevice,
  listDoorGuests,
  listScannerDevices,
  runBulkOrderAction,
  searchOrders,
  webDoorScan,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!adminUrl || !redisUrl)('admin lists, bulk actions, web door (integration)', () => {
  const dbName = `tix_adminlists_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let eventId: string;
  let userId: string;
  const ids: Record<string, string> = {};

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
    const [user] = await db
      .insert(adminUsers)
      .values({
        email: `door-${randomUUID().slice(0, 6)}@example.org`,
        displayName: 'Door Dora',
        passwordHash: 'x',
        roles: ['DOOR_STAFF'],
      })
      .returning();
    userId = user!.id;
    const [venue] = await db
      .insert(venues)
      .values({ name: 'Hall', slug: `h-${randomUUID().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
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
    await db.insert(seatMapSections).values({
      seatMapId: map!.id,
      type: 'STANDING',
      name: 'Floor',
      ticketLabel: 'Floor',
      capacity: 100,
      geometry: { type: 'rect', x: 0, y: 0, width: 50, height: 50, rotation: 0 },
    });
    const [tax] = await db.select().from(taxRates).limit(1);
    const [event] = await db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `ev-${randomUUID().slice(0, 6)}`,
        title: 'Show',
        startsAt: new Date('2026-07-01T18:00:00Z'),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
        status: 'PUBLISHED',
      })
      .returning();
    eventId = event!.id;

    const base = {
      channel: 'BOX_OFFICE' as const,
      firstName: 'Max',
      lastName: 'Muster',
      locale: 'en',
      currency: 'EUR',
    };
    const make = async (
      key: string,
      over: Partial<typeof orders.$inferInsert> & { totalGross: number },
    ) => {
      const [o] = await db
        .insert(orders)
        .values({
          ...base,
          orderNumber: `L-${key}-${randomUUID().slice(0, 6)}`,
          status: 'PAID',
          paymentMethod: 'CASH',
          subtotalGross: over.totalGross,
          totalNet: over.totalGross,
          totalTax: 0,
          amountPaid: over.totalGross,
          paidAt: new Date('2026-06-01T10:00:00Z'),
          createdAt: new Date('2026-06-01T10:00:00Z'),
          ...over,
        })
        .returning();
      ids[key] = o!.id;
    };
    const due = new Date(Date.now() + 5 * 86_400_000);
    await make('cheap', { totalGross: 1000, createdAt: new Date('2026-06-01T10:00:00Z') });
    await make('mid', { totalGross: 2500, createdAt: new Date('2026-06-05T10:00:00Z') });
    await make('big', { totalGross: 9000, createdAt: new Date('2026-06-09T10:00:00Z') });
    await make('open', {
      totalGross: 3000,
      amountPaid: 0,
      paidAt: null,
      status: 'AWAITING_PAYMENT',
      paymentMethod: 'BANK_TRANSFER',
      email: 'buyer@example.org',
      paymentReference: 'TIX-2026-123456-7',
      paymentDueAt: due,
      createdAt: new Date('2026-06-07T10:00:00Z'),
    });
    await make('open2', {
      totalGross: 3500,
      amountPaid: 0,
      paidAt: null,
      status: 'AWAITING_PAYMENT',
      paymentMethod: 'BANK_TRANSFER',
      email: 'buyer@example.org',
      paymentReference: 'TIX-2026-123457-5',
      paymentDueAt: due,
      createdAt: new Date('2026-06-08T10:00:00Z'),
    });
  });

  afterAll(async () => {
    await handle?.close();
    await redis?.quit();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);

  it('sorts by total in both directions with a stable tie-break', async () => {
    const asc = await searchOrders(ctx, { sort: 'total', dir: 'asc' });
    expect(idsOf(asc.rows)).toEqual([ids.cheap, ids.mid, ids.open, ids.open2, ids.big]);
    const desc = await searchOrders(ctx, { sort: 'total', dir: 'desc' });
    expect(idsOf(desc.rows)).toEqual([ids.big, ids.open2, ids.open, ids.mid, ids.cheap]);
    const byDate = await searchOrders(ctx, {});
    expect(byDate.rows[0]!.id).toBe(ids.big);
    expect(byDate.total).toBe(5);
  });

  it('filters by the inclusive local date range in the given time zone', async () => {
    const range = await searchOrders(ctx, {
      from: '2026-06-05',
      to: '2026-06-07',
      timeZone: 'Europe/Berlin',
      sort: 'date',
      dir: 'asc',
    });
    expect(idsOf(range.rows)).toEqual([ids.mid, ids.open]);
    expect((await searchOrders(ctx, { from: '2026-06-10' })).total).toBe(0);
    expect((await searchOrders(ctx, { to: '2026-06-01' })).total).toBe(1);
  });

  it('filters open orders', async () => {
    const open = await searchOrders(ctx, { openOnly: true });
    expect(new Set(idsOf(open.rows))).toEqual(new Set([ids.open, ids.open2]));
  });

  it('bulk keep-reserved reports per order and is idempotent', async () => {
    const run = () =>
      runBulkOrderAction(ctx, {
        action: 'keepReservedOn',
        orderIds: [ids.open!, ids.cheap!, randomUUID()],
        userId,
      });
    const first = await run();
    expect(first.map((r) => r.outcome)).toEqual(['done', 'failed', 'failed']);
    expect(first[1]!.code).toBe('ORDER_NOT_OPEN');
    expect(first[2]!.code).toBe('ORDER_NOT_FOUND');
    const second = await run();
    expect(second[0]).toMatchObject({ outcome: 'skipped', code: 'UNCHANGED' });
    const history = await handle.db
      .select()
      .from(orderHistory)
      .where(eq(orderHistory.orderId, ids.open!));
    expect(history.filter((h) => h.type === 'keep_reserved_changed')).toHaveLength(1);
    const off = await runBulkOrderAction(ctx, {
      action: 'keepReservedOff',
      orderIds: [ids.open!],
      userId,
    });
    expect(off[0]!.outcome).toBe('done');
  });

  it('bulk payment reminder: only unpaid transfer orders, once per cooldown', async () => {
    const first = await runBulkOrderAction(ctx, {
      action: 'remind',
      orderIds: [ids.open2!, ids.mid!],
      userId,
    });
    expect(first[0]!.outcome).toBe('done');
    expect(first[1]).toMatchObject({ outcome: 'failed', code: 'REMINDER_NOT_APPLICABLE' });
    const again = await runBulkOrderAction(ctx, {
      action: 'remind',
      orderIds: [ids.open2!],
      userId,
    });
    expect(again[0]).toMatchObject({ outcome: 'skipped', code: 'RECENTLY_REMINDED' });
    const [row] = await handle.db.select().from(orders).where(eq(orders.id, ids.open2!));
    expect(row!.reminderCount).toBe(1);
  });

  it('bulk cancel: unpaid orders are cancelled, paid ones are refused, repeats are skipped', async () => {
    const run = () =>
      runBulkOrderAction(ctx, {
        action: 'cancelUnpaid',
        orderIds: [ids.open2!, ids.mid!],
        userId,
      });
    const first = await run();
    expect(first[0]!.outcome).toBe('done');
    expect(first[1]).toMatchObject({ outcome: 'failed', code: 'ORDER_NOT_CANCELLABLE' });
    const second = await run();
    expect(second[0]).toMatchObject({ outcome: 'skipped', code: 'UNCHANGED' });
    const [row] = await handle.db.select().from(orders).where(eq(orders.id, ids.open2!));
    expect(row!.status).toBe('CANCELLED');
    const [paid] = await handle.db.select().from(orders).where(eq(orders.id, ids.mid!));
    expect(paid!.status).toBe('PAID');
  });

  it('web door desk: private archived device, same journal, hidden from the device list', async () => {
    const device = await ensureWebDoorDevice(ctx, {
      userId,
      displayName: 'Door Dora',
      eventId,
    });
    expect(device.name).toBe('Web (Door Dora)');
    const again = await ensureWebDoorDevice(ctx, { userId, displayName: 'Door Dora', eventId });
    expect(again.id).toBe(device.id);
    expect((await listScannerDevices(ctx)).some((d) => d.id === device.id)).toBe(false);

    // Unknown ticket: decided and journaled by the shared pipeline, attributed to the web desk.
    const outcome = await webDoorScan(ctx, {
      userId,
      displayName: 'Door Dora',
      eventId,
      ticketId: randomUUID(),
      action: 'CHECK_IN',
    });
    expect(outcome.result).toBe('REJECTED_UNKNOWN_TICKET');
    expect(outcome.color).toBe('RED');
    const logs = await handle.db
      .select()
      .from(checkInLogs)
      .where(eq(checkInLogs.deviceId, device.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.source).toBe('MANUAL');

    const list = await listDoorGuests(ctx, { eventId, q: 'nobody' });
    expect(list).toMatchObject({ guests: [], total: 0 });
  });
});
