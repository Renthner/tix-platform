import { bankTransactions, emailMessages, events } from '@tix/db';
import { QUEUE_NAMES, listLiveRealtime, listLiveWorkers, type QueueName } from '@tix/redis';
import { APP_VERSION } from '@tix/shared';
import { inArray, sql } from 'drizzle-orm';
import { shopCacheStats } from '../cache/shop-cache';
import type { CacheStats } from '../cache/tag-cache';
import type { CoreContext } from '../context';
import { coreLog } from '../log';
import { shopPresenceCounts } from '../presence';
import { countOpenRefunds } from '../orders/refunds';

/**
 * Live system status for the admin "System" page and the Prometheus endpoint. Every block is
 * collected independently: a failing dependency fills `errors` instead of breaking the page
 * (which is exactly when the page is needed). Nothing here scans the Redis keyspace (`KEYS`);
 * counters come from the existing per-event structures. Query texts of other sessions are never
 * read (they can contain personal data).
 */

export interface QueueStats {
  name: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface FailedJobInfo {
  queue: QueueName;
  name: string;
  id: string;
  /** Truncated: the reason can be long (stack traces never included). */
  reason: string;
  attempts: number;
  /** ISO timestamp the job failed at. */
  failedAt: string | null;
}

export interface SystemStats {
  generatedAt: string;
  app: {
    version: string;
    uptimeSeconds: number;
    nodeVersion: string;
    rssBytes: number;
    heapUsedBytes: number;
  };
  /** Shop data cache of THIS web process (counters since process start). */
  shopCache: CacheStats;
  postgres: {
    version: string;
    connections: number;
    maxConnections: number;
    databaseSizeBytes: number;
    longestQuerySeconds: number;
  } | null;
  redis: {
    version: string;
    usedMemoryBytes: number;
    /** 0 = no limit configured. */
    maxMemoryBytes: number;
    connectedClients: number;
    opsPerSecond: number;
    /** hits / (hits + misses), null while there were no lookups. */
    hitRatio: number | null;
    uptimeSeconds: number;
  } | null;
  queues: QueueStats[] | null;
  failedJobs: FailedJobInfo[];
  waitingRoom: {
    /** Shoppers with a heartbeat in the last 45 s (whole shop). */
    shopSessions: number;
    events: {
      eventId: string;
      title: string;
      waiting: number;
      lobby: number;
      active: number;
    }[];
  } | null;
  seatLocks: {
    total: number;
    events: { eventId: string; title: string; seats: number; standing: number }[];
  } | null;
  realtime: {
    /** Instances that sent a heartbeat (older gateway images do not: 0 = "not reporting"). */
    instances: number;
    sockets: number;
    versions: string[];
  } | null;
  workers: {
    live: {
      workerId: string;
      version: string;
      startedAt: string;
      lastBeatAt: string;
      leader: boolean;
    }[];
    /** Worker holding the loop lease (lock sweeper, waiting-room ticker); null = nobody. */
    leaderId: string | null;
  } | null;
  backlog: {
    emailPending: number;
    emailFailed: number;
    openRefunds: number;
    unmatchedBankTransactions: number;
  } | null;
  /** Names of the blocks that could not be collected. */
  errors: string[];
}

const MAX_EVENTS = 20;
const REASON_MAX = 300;
const FAILED_JOBS_SHOWN = 20;
const num = (v: unknown) => Number(v ?? 0) || 0;

/** `INFO` reply → flat key/value map (all sections). */
export function parseRedisInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function titles(ctx: Pick<CoreContext, 'db'>, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: events.id, title: events.title })
    .from(events)
    .where(inArray(events.id, ids));
  return new Map(rows.map((r) => [r.id, r.title]));
}

async function collectPostgres(ctx: CoreContext): Promise<SystemStats['postgres']> {
  const { rows } = await ctx.db.execute<Record<string, unknown>>(sql`
    SELECT current_setting('server_version') AS version,
           (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections,
           current_setting('max_connections')::int AS max_connections,
           pg_database_size(current_database())::bigint AS size,
           (SELECT COALESCE(max(EXTRACT(EPOCH FROM now() - query_start)), 0)
              FROM pg_stat_activity
             WHERE datname = current_database() AND state = 'active'
               AND backend_type = 'client backend' AND pid <> pg_backend_pid()) AS longest`);
  const r = rows[0] ?? {};
  return {
    version: String(r.version ?? ''),
    connections: num(r.connections),
    maxConnections: num(r.max_connections),
    databaseSizeBytes: num(r.size),
    longestQuerySeconds: Math.round(num(r.longest) * 10) / 10,
  };
}

async function collectRedis(ctx: CoreContext): Promise<SystemStats['redis']> {
  const info = parseRedisInfo(await ctx.redis.info());
  const hits = num(info.keyspace_hits);
  const misses = num(info.keyspace_misses);
  return {
    version: info.redis_version ?? '',
    usedMemoryBytes: num(info.used_memory),
    maxMemoryBytes: num(info.maxmemory),
    connectedClients: num(info.connected_clients),
    opsPerSecond: num(info.instantaneous_ops_per_sec),
    hitRatio: hits + misses > 0 ? hits / (hits + misses) : null,
    uptimeSeconds: num(info.uptime_in_seconds),
  };
}

async function collectQueues(
  ctx: CoreContext,
): Promise<{ queues: QueueStats[]; failedJobs: FailedJobInfo[] }> {
  const jobs = ctx.jobs;
  if (!jobs) throw new Error('job queues are not available in this process');
  const names = Object.values(QUEUE_NAMES) as QueueName[];
  const queues = await Promise.all(
    names.map(async (name): Promise<QueueStats> => {
      const c = await jobs.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
      return {
        name,
        waiting: num(c.waiting),
        active: num(c.active),
        delayed: num(c.delayed),
        failed: num(c.failed),
      };
    }),
  );
  const failedLists = await Promise.all(
    queues
      .filter((q) => q.failed > 0)
      .map(async (q) =>
        (await jobs.queue(q.name).getFailed(0, FAILED_JOBS_SHOWN - 1)).map(
          (job): FailedJobInfo => ({
            queue: q.name,
            name: job.name,
            id: String(job.id ?? ''),
            reason: (job.failedReason ?? '').slice(0, REASON_MAX),
            attempts: job.attemptsMade,
            failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          }),
        ),
      ),
  );
  const failedJobs = failedLists
    .flat()
    .sort((a, b) => (b.failedAt ?? '').localeCompare(a.failedAt ?? ''))
    .slice(0, FAILED_JOBS_SHOWN);
  return { queues, failedJobs };
}

async function collectWaitingRoom(ctx: CoreContext): Promise<SystemStats['waitingRoom']> {
  const ids = (await ctx.redis.smembers(ctx.keys.activeQueueEvents())).slice(0, MAX_EVENTS);
  const [counts, names, presence] = await Promise.all([
    ctx.queue.countsMany(ids),
    titles(ctx, ids),
    shopPresenceCounts(ctx, []),
  ]);
  return {
    shopSessions: presence.shop,
    events: ids.map((eventId) => ({
      eventId,
      title: names.get(eventId) ?? eventId,
      ...(counts.get(eventId) ?? { waiting: 0, lobby: 0, active: 0 }),
    })),
  };
}

async function collectSeatLocks(ctx: CoreContext): Promise<SystemStats['seatLocks']> {
  const ids = (await ctx.redis.smembers(ctx.keys.activeLockEvents())).slice(0, MAX_EVENTS);
  if (ids.length === 0) return { total: 0, events: [] };
  const now = Date.now();
  const pipeline = ctx.redis.pipeline();
  for (const id of ids) {
    pipeline.zcount(ctx.keys.seatLockExpiries(id), now, '+inf');
    pipeline.hvals(ctx.keys.generalAdmissionHeld(id));
  }
  const replies = (await pipeline.exec()) ?? [];
  const names = await titles(ctx, ids);
  const rows = ids.map((eventId, i) => ({
    eventId,
    title: names.get(eventId) ?? eventId,
    seats: num(replies[i * 2]?.[1]),
    standing: ((replies[i * 2 + 1]?.[1] as string[] | undefined) ?? []).reduce(
      (sum, v) => sum + num(v),
      0,
    ),
  }));
  const events = rows.filter((r) => r.seats > 0 || r.standing > 0);
  return { total: events.reduce((s, r) => s + r.seats + r.standing, 0), events };
}

async function collectRealtime(ctx: CoreContext): Promise<SystemStats['realtime']> {
  const live = await listLiveRealtime(ctx.redis, ctx.keys, 30);
  return {
    instances: live.length,
    sockets: live.reduce((s, i) => s + i.sockets, 0),
    versions: [...new Set(live.map((i) => i.version))],
  };
}

async function collectWorkers(ctx: CoreContext): Promise<SystemStats['workers']> {
  const [live, leaderId] = await Promise.all([
    listLiveWorkers(ctx.redis, ctx.keys, 60),
    ctx.redis.get(ctx.keys.mutex('worker-loops')),
  ]);
  return {
    leaderId,
    live: live.map((w) => ({
      workerId: w.workerId,
      version: w.version,
      startedAt: w.startedAt,
      lastBeatAt: w.lastBeatAt,
      leader: w.workerId === leaderId,
    })),
  };
}

async function collectBacklog(ctx: CoreContext): Promise<SystemStats['backlog']> {
  const [mail, bank, openRefunds] = await Promise.all([
    ctx.db.execute<{ pending: number; failed: number }>(sql`
      SELECT count(*) FILTER (WHERE status IN ('QUEUED','SENDING'))::int AS pending,
             count(*) FILTER (WHERE status = 'FAILED')::int AS failed
      FROM ${emailMessages}
      WHERE status IN ('QUEUED','SENDING','FAILED')`),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bankTransactions)
      .where(inArray(bankTransactions.matchStatus, ['UNMATCHED', 'NEEDS_REVIEW'])),
    countOpenRefunds(ctx),
  ]);
  return {
    emailPending: num(mail.rows[0]?.pending),
    emailFailed: num(mail.rows[0]?.failed),
    openRefunds,
    unmatchedBankTransactions: bank[0]?.n ?? 0,
  };
}

/** Collects the status of every subsystem (cheap: a dozen small queries, no keyspace scans). */
export async function collectSystemStats(ctx: CoreContext): Promise<SystemStats> {
  const errors: string[] = [];
  const guard = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(name);
      coreLog.warn({ err, block: name }, 'system statistics block failed');
      return null;
    }
  };
  const [postgres, redis, queueData, waitingRoom, seatLocks, realtime, workers, backlog] =
    await Promise.all([
      guard('postgres', () => collectPostgres(ctx)),
      guard('redis', () => collectRedis(ctx)),
      guard('queues', () => collectQueues(ctx)),
      guard('waitingRoom', () => collectWaitingRoom(ctx)),
      guard('seatLocks', () => collectSeatLocks(ctx)),
      guard('realtime', () => collectRealtime(ctx)),
      guard('workers', () => collectWorkers(ctx)),
      guard('backlog', () => collectBacklog(ctx)),
    ]);
  const memory = process.memoryUsage();
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
    shopCache: shopCacheStats(),
    postgres,
    redis,
    queues: queueData?.queues ?? null,
    failedJobs: queueData?.failedJobs ?? [],
    waitingRoom,
    seatLocks,
    realtime,
    workers,
    backlog,
    errors,
  };
}

// ─── Short server-side cache: several open tabs share one collection ────────────

const CACHE_TTL_MS = 3_000;
const globalCache = globalThis as typeof globalThis & {
  __tixSystemStats?: { at: number; value?: SystemStats; pending?: Promise<SystemStats> };
};

export async function getSystemStats(ctx: CoreContext): Promise<SystemStats> {
  const entry = (globalCache.__tixSystemStats ??= { at: 0 });
  if (entry.value && Date.now() - entry.at < CACHE_TTL_MS) return entry.value;
  entry.pending ??= collectSystemStats(ctx)
    .then((value) => {
      entry.value = value;
      entry.at = Date.now();
      return value;
    })
    .finally(() => {
      entry.pending = undefined;
    });
  return entry.pending;
}
