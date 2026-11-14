/**
 * System status against real PostgreSQL and Redis (throw-away database and key prefix):
 * block collection, seat lock / waiting room counters, heartbeats, queue counts, failure isolation.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, loadRootEnv, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { QUEUE_NAMES, writeRealtimeHeartbeat, writeWorkerHeartbeat } from '@tix/redis';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JobQueues,
  collectSystemStats,
  createCoreContext,
  renderPrometheus,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!adminUrl || !redisUrl)('system statistics (integration)', () => {
  const dbName = `tix_sys_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let bull: Redis;
  let jobs: JobQueues;
  let ctx: CoreContext;
  const eventId = randomUUID();

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
    bull = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const prefix = `t${randomUUID().slice(0, 8)}`;
    jobs = new JobQueues(bull, `${prefix}:bull`);
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: prefix,
      sessionSecret: 'x'.repeat(48),
      jobs,
    });
  });

  afterAll(async () => {
    await jobs?.close();
    bull?.disconnect();
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('collects every block and counts queue jobs, locks, waiting room and heartbeats', async () => {
    await jobs.add(QUEUE_NAMES.email, 'send', { x: 1 });
    await jobs.add(QUEUE_NAMES.email, 'send', { x: 2 }, { delay: 60_000 });
    // Two seats and three standing spots held in carts.
    await redis.sadd(ctx.keys.activeLockEvents(), eventId);
    await redis.zadd(
      ctx.keys.seatLockExpiries(eventId),
      Date.now() + 60_000,
      's1',
      Date.now() + 60_000,
      's2',
    );
    await redis.zadd(ctx.keys.seatLockExpiries(eventId), Date.now() - 60_000, 'expired');
    await redis.hset(ctx.keys.generalAdmissionHeld(eventId), 'sec1', 2, 'sec2', 1);
    // Waiting room of the event.
    await redis.sadd(ctx.keys.activeQueueEvents(), eventId);
    await redis.zadd(ctx.keys.queueWaiting(eventId), 1, 'a', 2, 'b', 3, 'c');
    await redis.zadd(ctx.keys.queueActive(eventId), Date.now(), 'd');
    // Worker + leader lease and a realtime gateway.
    const now = new Date().toISOString();
    await writeWorkerHeartbeat(
      redis,
      ctx.keys,
      {
        workerId: 'w1',
        hostname: 'h',
        pid: 1,
        version: '1.2.3',
        startedAt: now,
        lastBeatAt: now,
        queues: [],
      },
      30,
    );
    await redis.set(ctx.keys.mutex('worker-loops'), 'w1', 'PX', 5_000);
    await writeRealtimeHeartbeat(
      redis,
      ctx.keys,
      {
        instanceId: 'r1',
        hostname: 'h',
        pid: 2,
        version: '1.2.3',
        startedAt: now,
        lastBeatAt: now,
        sockets: 42,
      },
      30,
    );

    const stats = await collectSystemStats(ctx);
    expect(stats.errors).toEqual([]);
    expect(stats.app.version).toBeTruthy();
    expect(stats.postgres?.maxConnections).toBeGreaterThan(0);
    expect(stats.postgres?.connections).toBeGreaterThan(0);
    expect(stats.postgres?.databaseSizeBytes).toBeGreaterThan(0);
    expect(stats.redis?.usedMemoryBytes).toBeGreaterThan(0);
    expect(stats.redis?.version).toMatch(/^\d/);

    const email = stats.queues?.find((q) => q.name === 'email');
    expect(email).toMatchObject({ waiting: 1, delayed: 1, active: 0, failed: 0 });
    expect(stats.queues).toHaveLength(Object.keys(QUEUE_NAMES).length);

    expect(stats.seatLocks).toMatchObject({ total: 5 });
    expect(stats.seatLocks?.events[0]).toMatchObject({ eventId, seats: 2, standing: 3 });
    expect(stats.waitingRoom?.events[0]).toMatchObject({
      eventId,
      waiting: 3,
      active: 1,
      lobby: 0,
    });
    expect(stats.realtime).toMatchObject({ instances: 1, sockets: 42 });
    expect(stats.workers?.leaderId).toBe('w1');
    expect(stats.workers?.live[0]).toMatchObject({
      workerId: 'w1',
      leader: true,
      version: '1.2.3',
    });
    expect(stats.backlog).toMatchObject({ emailPending: 0, emailFailed: 0, openRefunds: 0 });

    const text = renderPrometheus(stats);
    expect(text).toContain('tix_queue_jobs{queue="email",state="waiting"} 1');
    expect(text).toContain('tix_realtime_sockets 42');
    expect(text).toContain(`tix_seat_locks_by_event{event_id="${eventId}",kind="seat"} 2`);
  });

  it('reports a failing block instead of failing as a whole', async () => {
    const broken = { ...ctx, jobs: undefined } as CoreContext;
    const stats = await collectSystemStats(broken);
    expect(stats.errors).toContain('queues');
    expect(stats.queues).toBeNull();
    expect(stats.redis).not.toBeNull();
    expect(renderPrometheus(stats)).toContain('tix_collect_error{block="queues"} 1');
  });
});
