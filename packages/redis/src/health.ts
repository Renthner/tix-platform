import type { Redis } from 'ioredis';
import type { Keyspace } from './keys';

/** Round-trip latency in ms. */
export async function pingRedis(client: Redis): Promise<number> {
  const started = performance.now();
  const reply = await client.ping();
  if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${reply}`);
  return Math.round((performance.now() - started) * 100) / 100;
}

export interface RedisConfigReport {
  evictionPolicy?: string;
  appendOnly?: string;
  warnings: string[];
}

/**
 * Verifies server settings the platform relies on. Seat locks and BullMQ jobs must never be
 * evicted under memory pressure → `maxmemory-policy noeviction` is mandatory.
 * Managed Redis offerings may forbid CONFIG GET; that is reported as a warning only.
 */
export async function inspectRedisConfig(client: Redis): Promise<RedisConfigReport> {
  const warnings: string[] = [];
  const report: RedisConfigReport = { warnings };
  try {
    const policy = (await client.config('GET', 'maxmemory-policy')) as string[];
    report.evictionPolicy = policy[1];
    if (report.evictionPolicy !== 'noeviction') {
      warnings.push(
        `maxmemory-policy is "${report.evictionPolicy}" – must be "noeviction" (seat locks / BullMQ jobs could be evicted)`,
      );
    }
    const aof = (await client.config('GET', 'appendonly')) as string[];
    report.appendOnly = aof[1];
    if (report.appendOnly !== 'yes') {
      warnings.push('appendonly is disabled – queue state is lost on Redis restart');
    }
  } catch (err) {
    warnings.push(
      `CONFIG GET not permitted (${(err as Error).message}); verify eviction policy manually`,
    );
  }
  return report;
}

export interface WorkerHeartbeat {
  workerId: string;
  hostname: string;
  pid: number;
  version: string;
  startedAt: string;
  lastBeatAt: string;
  queues: string[];
}

export async function writeWorkerHeartbeat(
  client: Redis,
  keys: Keyspace,
  beat: WorkerHeartbeat,
  ttlSeconds: number,
): Promise<void> {
  const now = Date.now();
  await client
    .multi()
    .set(keys.workerHeartbeat(beat.workerId), JSON.stringify(beat), 'EX', ttlSeconds)
    .zadd(keys.workerHeartbeats(), now, beat.workerId)
    .zremrangebyscore(keys.workerHeartbeats(), '-inf', now - ttlSeconds * 1000)
    .exec();
}

export async function removeWorkerHeartbeat(
  client: Redis,
  keys: Keyspace,
  workerId: string,
): Promise<void> {
  await client
    .multi()
    .del(keys.workerHeartbeat(workerId))
    .zrem(keys.workerHeartbeats(), workerId)
    .exec();
}

/** Workers that sent a heartbeat within `maxAgeSeconds`. */
export async function listLiveWorkers(
  client: Redis,
  keys: Keyspace,
  maxAgeSeconds: number,
): Promise<WorkerHeartbeat[]> {
  const ids = await client.zrangebyscore(
    keys.workerHeartbeats(),
    Date.now() - maxAgeSeconds * 1000,
    '+inf',
  );
  if (ids.length === 0) return [];
  const raw = await client.mget(ids.map((id) => keys.workerHeartbeat(id)));
  return raw.flatMap((value) => {
    if (!value) return [];
    try {
      return [JSON.parse(value) as WorkerHeartbeat];
    } catch {
      return [];
    }
  });
}

/** Heartbeat of one realtime gateway instance (Socket.io), shown on the admin system page. */
export interface RealtimeHeartbeat {
  instanceId: string;
  hostname: string;
  pid: number;
  version: string;
  startedAt: string;
  lastBeatAt: string;
  /** Currently connected Socket.io clients of this instance. */
  sockets: number;
}

export async function writeRealtimeHeartbeat(
  client: Redis,
  keys: Keyspace,
  beat: RealtimeHeartbeat,
  ttlSeconds: number,
): Promise<void> {
  const now = Date.now();
  await client
    .multi()
    .set(keys.realtimeHeartbeat(beat.instanceId), JSON.stringify(beat), 'EX', ttlSeconds)
    .zadd(keys.realtimeHeartbeats(), now, beat.instanceId)
    .zremrangebyscore(keys.realtimeHeartbeats(), '-inf', now - ttlSeconds * 1000)
    .exec();
}

export async function removeRealtimeHeartbeat(
  client: Redis,
  keys: Keyspace,
  instanceId: string,
): Promise<void> {
  await client
    .multi()
    .del(keys.realtimeHeartbeat(instanceId))
    .zrem(keys.realtimeHeartbeats(), instanceId)
    .exec();
}

/** Realtime instances that sent a heartbeat within `maxAgeSeconds`. */
export async function listLiveRealtime(
  client: Redis,
  keys: Keyspace,
  maxAgeSeconds: number,
): Promise<RealtimeHeartbeat[]> {
  const ids = await client.zrangebyscore(
    keys.realtimeHeartbeats(),
    Date.now() - maxAgeSeconds * 1000,
    '+inf',
  );
  if (ids.length === 0) return [];
  const raw = await client.mget(ids.map((id) => keys.realtimeHeartbeat(id)));
  return raw.flatMap((value) => {
    if (!value) return [];
    try {
      return [JSON.parse(value) as RealtimeHeartbeat];
    } catch {
      return [];
    }
  });
}
