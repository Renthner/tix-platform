/**
 * Server-wide cap of the virtual waiting room (setting `queueCapacity.maxActiveShoppers`) against
 * real PostgreSQL + Redis: the per-event threshold counts one event, the cap all events together.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  accessCodes,
  createDb,
  events,
  seatMaps,
  loadRootEnv,
  queueConfigs,
  taxRates,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import type { QueueMode } from '@tix/shared';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimPass,
  cleanupRedisAfterRestore,
  createCoreContext,
  enterShop,
  getEventById,
  redeemAccessCode,
  saveSetting,
  tickWaitingRooms,
  type CoreContext,
  type EventRow,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const uuid = () => randomUUID();
const sid = (p: string) => `${p}${uuid().slice(0, 8)}`;

describe.skipIf(!adminUrl || !redisUrl)('waiting room server-wide cap (integration)', () => {
  const dbName = `tix_qcap_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let venueId: string;
  let taxRateId: string;

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
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    venueId = venue!.id;
    const [tax] = await handle.db
      .insert(taxRates)
      .values({ name: `t-${uuid()}`, rateBasisPoints: 700 })
      .returning();
    taxRateId = tax!.id;
  });

  // Fresh key prefix per test: the server-wide active set is shared by all events of a prefix.
  const prefixes: string[] = [];
  beforeEach(() => {
    const keyPrefix = `qcap${uuid().slice(0, 8)}`;
    prefixes.push(keyPrefix);
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix,
      sessionSecret: 'x'.repeat(48),
    });
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) {
      // Only this file's own prefixes: other suites run in parallel on the same Redis.
      for (const prefix of prefixes) {
        let cursor = '0';
        do {
          const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);
          if (found.length) await redis.del(...found);
          cursor = next;
        } while (cursor !== '0');
      }
      await redis.quit();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function setCap(value: number | null) {
    await saveSetting(ctx, 'queueCapacity', { maxActiveShoppers: value }, null);
  }

  async function createEvent(
    mode: QueueMode,
    threshold = 100,
    extra: Partial<typeof queueConfigs.$inferInsert> = {},
  ): Promise<EventRow> {
    const [map] = await handle.db
      .insert(seatMaps)
      .values({ venueId, kind: 'EVENT', name: 'Hall', canvasWidth: 800, canvasHeight: 600 })
      .returning();
    const [ev] = await handle.db
      .insert(events)
      .values({
        venueId,
        seatMapId: map!.id,
        slug: `ev-${uuid().slice(0, 8)}`,
        title: 'Concert',
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId,
      })
      .returning();
    await handle.db.insert(queueConfigs).values({
      eventId: ev!.id,
      mode,
      activeSessionThreshold: threshold,
      admissionBatchSize: 10,
      admissionIntervalSeconds: 1,
      passTokenTtlSeconds: 600,
      ...extra,
    });
    return getEventById(ctx, ev!.id);
  }

  const activeAllKey = () => ctx.keys.queueActiveAll();

  it('cap off: every event only follows its own threshold', async () => {
    await setCap(null);
    const [a, b] = [await createEvent('AUTO_THRESHOLD', 2), await createEvent('AUTO_THRESHOLD', 2)];
    for (const ev of [a, b, a, b])
      expect((await enterShop(ctx, ev, sid('s'))).status).toBe('GRANTED');
    expect((await enterShop(ctx, a, sid('s'))).status).toBe('QUEUED');
    expect(await ctx.queue.activeAllCount()).toBe(4);
  });

  it('cap 3 over two events: the 4th visitor queues although the event is below its threshold', async () => {
    await setCap(3);
    const [a, b] = [await createEvent('AUTO_THRESHOLD'), await createEvent('AUTO_THRESHOLD')];
    expect((await enterShop(ctx, a, sid('a'))).status).toBe('GRANTED');
    expect((await enterShop(ctx, a, sid('a'))).status).toBe('GRANTED');
    expect((await enterShop(ctx, b, sid('b'))).status).toBe('GRANTED');
    const waitingB = sid('b');
    expect((await enterShop(ctx, b, waitingB)).status).toBe('QUEUED');
    expect((await enterShop(ctx, a, sid('a'))).status).toBe('QUEUED');

    // the ticker does not admit beyond the cap
    await tickWaitingRooms(ctx);
    expect((await ctx.queue.position(b.id, waitingB)).admittedAt).toBeNull();
    expect(await ctx.queue.activeAllCount()).toBe(3);

    // one pass expires (no heartbeat within the window) → the next one gets in via the ticker
    const [first] = await redis.zrange(activeAllKey(), 0, 0);
    await redis.zadd(activeAllKey(), Date.now() - 1, first!);
    await tickWaitingRooms(ctx, Date.now() + 2_000);
    const admittedA = (await ctx.queue.snapshot(a.id)).admittedPending;
    const admittedB = (await ctx.queue.snapshot(b.id)).admittedPending;
    expect(admittedA + admittedB).toBe(1);
    expect(await ctx.queue.activeAllCount()).toBe(3);
  });

  it('a freed slot lets the next newcomer in directly and claims never exceed the cap', async () => {
    await setCap(2);
    const [a, b] = [await createEvent('AUTO_THRESHOLD'), await createEvent('HYBRID')];
    expect((await enterShop(ctx, a, sid('a'))).status).toBe('GRANTED');
    const queued = sid('b');
    expect((await enterShop(ctx, b, queued)).status).toBe('QUEUED');
    await tickWaitingRooms(ctx);
    expect((await ctx.queue.position(b.id, queued)).admittedAt).not.toBeNull();
    // the pending admission reserves the last slot
    expect((await enterShop(ctx, a, sid('a'))).status).toBe('QUEUED');
    expect((await claimPass(ctx, b, queued)).status).toBe('GRANTED');
    expect(await ctx.queue.activeAllCount()).toBe(2);

    // reset of event B frees its slot; a new event-A visitor would still queue behind the
    // waiting visitor of A, so use a third event without queue
    await ctx.queue.reset(b.id);
    const c = await createEvent('AUTO_THRESHOLD');
    expect((await enterShop(ctx, c, sid('c'))).status).toBe('GRANTED');
  });

  it('freed global slots are shared across the lines of several events', async () => {
    await setCap(2);
    const [a, b] = [await createEvent('AUTO_THRESHOLD'), await createEvent('AUTO_THRESHOLD')];
    expect((await enterShop(ctx, a, sid('a'))).status).toBe('GRANTED');
    expect((await enterShop(ctx, a, sid('a'))).status).toBe('GRANTED');
    for (const ev of [a, b, a, b, a, b, a, b]) {
      expect((await enterShop(ctx, ev, sid('w'))).status).toBe('QUEUED');
    }
    let now = Date.now();
    const admittedOf = async (ev: EventRow) => (await ctx.queue.snapshot(ev.id)).admittedPending;
    // Two ticks, each after every counted slot expired: each tick has exactly 2 free slots. The
    // start event rotates, so both lines move although one event alone could take all slots.
    for (let tick = 0; tick < 2; tick += 1) {
      for (const member of await redis.zrange(activeAllKey(), 0, -1)) {
        await redis.zadd(activeAllKey(), 0, member);
      }
      now += 2_000;
      await tickWaitingRooms(ctx, now);
    }
    expect(await admittedOf(a)).toBe(2);
    expect(await admittedOf(b)).toBe(2);
  });

  it('restore cleanup drops the server-wide active set', async () => {
    await setCap(1);
    const a = await createEvent('AUTO_THRESHOLD');
    expect((await enterShop(ctx, a, sid('a'))).status).toBe('GRANTED');
    expect(await ctx.queue.activeAllCount()).toBe(1);
    await cleanupRedisAfterRestore(ctx);
    expect(await redis.exists(activeAllKey())).toBe(0);
  });

  it('bypass paths are counted but never refused by the cap', async () => {
    await setCap(1);
    const off = await createEvent('OFF');
    const auto = await createEvent('AUTO_THRESHOLD', 100, { accessCodeBypassesQueue: true });
    expect((await enterShop(ctx, off, sid('o'))).status).toBe('GRANTED');
    expect((await enterShop(ctx, off, sid('o'))).status).toBe('GRANTED');
    expect(await ctx.queue.activeAllCount()).toBe(2);
    // a normal visitor of an AUTO_THRESHOLD event queues: the server is over its cap
    expect((await enterShop(ctx, auto, sid('n'))).status).toBe('QUEUED');

    const [code] = await handle.db
      .insert(accessCodes)
      .values({
        eventId: auto.id,
        code: `CAP${uuid().slice(0, 6).toUpperCase()}`,
        type: 'MULTI_USE',
      })
      .returning();
    const vip = sid('v');
    await redeemAccessCode(ctx, auto, vip, code!.code);
    expect((await enterShop(ctx, auto, vip)).status).toBe('GRANTED');
    expect(await ctx.queue.activeAllCount()).toBe(3);

    // super-admins are neither counted nor refused
    const admin = { superAdmin: true };
    expect((await enterShop(ctx, auto, sid('sa'), admin)).status).toBe('GRANTED');
    expect(await ctx.queue.activeAllCount()).toBe(3);
  });
});
