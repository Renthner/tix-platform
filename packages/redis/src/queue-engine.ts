import type { Redis } from 'ioredis';
import type { Keyspace } from './keys';
import { defineScript, runScript } from './script';

/**
 * Virtual waiting room primitives (Redis + Lua).
 *
 * Model: every waiting session gets a queue number (admission order). The worker admits
 * the lowest numbers in batches and advances a public `cursor`; clients compute their
 * position as `number − cursor` from one broadcast value instead of per-user messages.
 * Admitted sessions claim a pass within the claim window; holders of a pass count as
 * "active shoppers" (heartbeat) against the capacity threshold.
 */

// KEYS: waiting, admitted, state, lobby   ARGV: sid, now, preferLobby(0/1)
const JOIN = defineScript(
  'queueJoin',
  `
local sid = ARGV[1]
local admittedAt = redis.call('ZSCORE', KEYS[2], sid)
if admittedAt then return {'admitted', admittedAt} end
local num = redis.call('ZSCORE', KEYS[1], sid)
if num then return {'waiting', num} end
if ARGV[3] == '1' and not redis.call('HGET', KEYS[3], 'drawnAt') then
  redis.call('ZADD', KEYS[4], 'NX', ARGV[2], sid)
  return {'lobby', '0'}
end
num = redis.call('HINCRBY', KEYS[3], 'seq', 1)
redis.call('ZADD', KEYS[1], num, sid)
return {'waiting', tostring(num)}
`,
);

// KEYS: lobby, waiting, state   ARGV: now, sid_1..sid_n (pre-shuffled order)
const DRAW = defineScript(
  'queueDraw',
  `
if redis.call('HGET', KEYS[3], 'drawnAt') then return -1 end
local count = 0
for i = 2, #ARGV do
  local sid = ARGV[i]
  if redis.call('ZREM', KEYS[1], sid) == 1 then
    local num = redis.call('HINCRBY', KEYS[3], 'seq', 1)
    redis.call('ZADD', KEYS[2], 'NX', num, sid)
    count = count + 1
  end
end
local late = redis.call('ZRANGE', KEYS[1], 0, -1)
for _, sid in ipairs(late) do
  local num = redis.call('HINCRBY', KEYS[3], 'seq', 1)
  redis.call('ZADD', KEYS[2], 'NX', num, sid)
  count = count + 1
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[3], 'drawnAt', ARGV[1])
return count
`,
);

// KEYS: waiting, admitted, state, active
// ARGV: now, batchSize, threshold(0 = none), activeWindowMs, claimWindowMs
const ADMIT = defineScript(
  'queueAdmit',
  `
local now = tonumber(ARGV[1])
local batch = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now - tonumber(ARGV[4]))
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[5]))
local cursor = tonumber(redis.call('HGET', KEYS[3], 'cursor') or '0')
local slots = batch
if threshold > 0 then
  slots = math.min(slots, threshold - redis.call('ZCARD', KEYS[4]) - redis.call('ZCARD', KEYS[2]))
end
redis.call('HSET', KEYS[3], 'lastTickAt', now)
local result = {0, cursor}
if slots <= 0 then return result end
local next = redis.call('ZRANGE', KEYS[1], 0, slots - 1, 'WITHSCORES')
for i = 1, #next, 2 do
  local sid = next[i]
  local num = tonumber(next[i + 1])
  redis.call('ZREM', KEYS[1], sid)
  redis.call('ZADD', KEYS[2], now, sid)
  if num > cursor then cursor = num end
  table.insert(result, sid)
end
result[1] = #next / 2
result[2] = cursor
redis.call('HSET', KEYS[3], 'cursor', cursor)
return result
`,
);

// KEYS: waiting, admitted, active, pass
// ARGV: sid, now, threshold(0 = none), activeWindowMs, claimWindowMs, jti, passTtlMs, ignoreQueue(0/1)
const ENTER_DIRECTLY = defineScript(
  'queueEnterDirectly',
  `
local sid = ARGV[1]
local now = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - tonumber(ARGV[4]))
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[5]))
if ARGV[8] ~= '1' then
  if redis.call('ZCARD', KEYS[1]) > 0 and not redis.call('ZSCORE', KEYS[2], sid) then return 0 end
  if threshold > 0 and not redis.call('ZSCORE', KEYS[3], sid) then
    local occupied = redis.call('ZCARD', KEYS[3]) + redis.call('ZCARD', KEYS[2])
    if occupied >= threshold then return 0 end
  end
end
redis.call('SET', KEYS[4], ARGV[6], 'PX', tonumber(ARGV[7]))
redis.call('ZREM', KEYS[2], sid)
redis.call('ZADD', KEYS[3], now, sid)
return 1
`,
);

// KEYS: admitted, active, pass   ARGV: sid, now, claimWindowMs, jti, passTtlMs
const CLAIM = defineScript(
  'queueClaim',
  `
local admittedAt = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not admittedAt or tonumber(admittedAt) < tonumber(ARGV[2]) - tonumber(ARGV[3]) then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('SET', KEYS[3], ARGV[4], 'PX', tonumber(ARGV[5]))
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`,
);

// KEYS: active, pass   ARGV: sid, now
const PING = defineScript(
  'queuePing',
  `
if redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
return 1
`,
);

// KEYS: counter   ARGV: limit, windowMs
const RATE_LIMIT = defineScript(
  'rateLimit',
  `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2])) end
local ttl = redis.call('PTTL', KEYS[1])
if count > tonumber(ARGV[1]) then return {0, count, ttl} end
return {1, count, ttl}
`,
);

export type JoinResult =
  | { status: 'lobby' }
  | { status: 'waiting'; number: number }
  | { status: 'admitted'; admittedAt: number };

export interface QueueSnapshot {
  waiting: number;
  lobby: number;
  admittedPending: number;
  active: number;
  cursor: number;
  seq: number;
  drawnAt: number | null;
}

export interface AdmitResult {
  admitted: string[];
  cursor: number;
}

export interface QueueTiming {
  activeWindowMs: number;
  claimWindowMs: number;
}

export class QueueEngine {
  constructor(
    private readonly redis: Redis,
    private readonly keys: Keyspace,
  ) {}

  async join(eventId: string, sessionId: string, preferLobby: boolean): Promise<JoinResult> {
    const k = this.keys;
    const [status, value] = await runScript<[string, string]>(
      this.redis,
      JOIN,
      [
        k.queueWaiting(eventId),
        k.queueAdmitted(eventId),
        k.queueState(eventId),
        k.queueLobby(eventId),
      ],
      [sessionId, Date.now(), preferLobby ? 1 : 0],
    );
    await this.redis.sadd(k.activeQueueEvents(), eventId);
    if (status === 'lobby') return { status: 'lobby' };
    if (status === 'admitted') return { status: 'admitted', admittedAt: Number(value) };
    return { status: 'waiting', number: Number(value) };
  }

  /** Moves the lobby into the queue in the given (already shuffled or FIFO) order. */
  async draw(eventId: string, orderedSessionIds: string[], now = Date.now()): Promise<number> {
    const k = this.keys;
    return runScript<number>(
      this.redis,
      DRAW,
      [k.queueLobby(eventId), k.queueWaiting(eventId), k.queueState(eventId)],
      [now, ...orderedSessionIds],
    );
  }

  lobbyMembers(eventId: string): Promise<string[]> {
    return this.redis.zrange(this.keys.queueLobby(eventId), 0, -1);
  }

  async admit(
    eventId: string,
    params: QueueTiming & { batchSize: number; threshold: number; now?: number },
  ): Promise<AdmitResult> {
    const k = this.keys;
    const [, cursor, ...admitted] = await runScript<[number, number, ...string[]]>(
      this.redis,
      ADMIT,
      [
        k.queueWaiting(eventId),
        k.queueAdmitted(eventId),
        k.queueState(eventId),
        k.queueActive(eventId),
      ],
      [
        params.now ?? Date.now(),
        params.batchSize,
        params.threshold,
        params.activeWindowMs,
        params.claimWindowMs,
      ],
    );
    return { admitted: admitted as string[], cursor: Number(cursor) };
  }

  /**
   * Grants a pass without queueing if the event has free capacity and nobody is waiting
   * (or unconditionally with `bypassQueue`, e.g. for valid VIP codes / mode OFF).
   */
  async enterDirectly(
    eventId: string,
    sessionId: string,
    params: QueueTiming & {
      threshold: number;
      jti: string;
      passTtlMs: number;
      bypassQueue: boolean;
    },
  ): Promise<boolean> {
    const k = this.keys;
    const result = await runScript<number>(
      this.redis,
      ENTER_DIRECTLY,
      [
        k.queueWaiting(eventId),
        k.queueAdmitted(eventId),
        k.queueActive(eventId),
        k.queuePass(eventId, sessionId),
      ],
      [
        sessionId,
        Date.now(),
        params.threshold,
        params.activeWindowMs,
        params.claimWindowMs,
        params.jti,
        params.passTtlMs,
        params.bypassQueue ? 1 : 0,
      ],
    );
    return result === 1;
  }

  /** Converts an admission into a pass (only within the claim window). */
  async claim(
    eventId: string,
    sessionId: string,
    params: { claimWindowMs: number; jti: string; passTtlMs: number },
  ): Promise<boolean> {
    const k = this.keys;
    const result = await runScript<number>(
      this.redis,
      CLAIM,
      [k.queueAdmitted(eventId), k.queueActive(eventId), k.queuePass(eventId, sessionId)],
      [sessionId, Date.now(), params.claimWindowMs, params.jti, params.passTtlMs],
    );
    return result === 1;
  }

  /** Marks a pass holder as active (heartbeat). Returns false if the pass expired. */
  async ping(eventId: string, sessionId: string): Promise<boolean> {
    const k = this.keys;
    const result = await runScript<number>(
      this.redis,
      PING,
      [k.queueActive(eventId), k.queuePass(eventId, sessionId)],
      [sessionId, Date.now()],
    );
    return result === 1;
  }

  /** Current pass token id (jti) of a session, or null. */
  passId(eventId: string, sessionId: string): Promise<string | null> {
    return this.redis.get(this.keys.queuePass(eventId, sessionId));
  }

  async position(
    eventId: string,
    sessionId: string,
  ): Promise<{ number: number | null; admittedAt: number | null; inLobby: boolean }> {
    const k = this.keys;
    const [number, admittedAt, lobby] = await Promise.all([
      this.redis.zscore(k.queueWaiting(eventId), sessionId),
      this.redis.zscore(k.queueAdmitted(eventId), sessionId),
      this.redis.zscore(k.queueLobby(eventId), sessionId),
    ]);
    return {
      number: number === null ? null : Number(number),
      admittedAt: admittedAt === null ? null : Number(admittedAt),
      inLobby: lobby !== null,
    };
  }

  async snapshot(eventId: string): Promise<QueueSnapshot> {
    const k = this.keys;
    const [waiting, lobby, admitted, active, state] = await Promise.all([
      this.redis.zcard(k.queueWaiting(eventId)),
      this.redis.zcard(k.queueLobby(eventId)),
      this.redis.zcard(k.queueAdmitted(eventId)),
      this.redis.zcard(k.queueActive(eventId)),
      this.redis.hgetall(k.queueState(eventId)),
    ]);
    return {
      waiting,
      lobby,
      admittedPending: admitted,
      active,
      cursor: Number(state.cursor ?? 0),
      seq: Number(state.seq ?? 0),
      drawnAt: state.drawnAt ? Number(state.drawnAt) : null,
    };
  }

  /** Active / waiting / lobby counters of many events in one Redis round trip (dashboard). */
  async countsMany(
    eventIds: readonly string[],
  ): Promise<Map<string, { active: number; waiting: number; lobby: number }>> {
    const result = new Map<string, { active: number; waiting: number; lobby: number }>();
    if (eventIds.length === 0) return result;
    const k = this.keys;
    const pipeline = this.redis.pipeline();
    for (const id of eventIds) {
      pipeline.zcard(k.queueActive(id));
      pipeline.zcard(k.queueWaiting(id));
      pipeline.zcard(k.queueLobby(id));
    }
    const replies = (await pipeline.exec()) ?? [];
    eventIds.forEach((id, i) => {
      const n = (offset: number) => Number(replies[i * 3 + offset]?.[1] ?? 0) || 0;
      result.set(id, { active: n(0), waiting: n(1), lobby: n(2) });
    });
    return result;
  }

  /** Clears the whole waiting room of an event (admin reset / event finished). */
  async reset(eventId: string): Promise<void> {
    const k = this.keys;
    await this.redis.del(
      k.queueWaiting(eventId),
      k.queueLobby(eventId),
      k.queueAdmitted(eventId),
      k.queueActive(eventId),
      k.queueState(eventId),
    );
  }
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterMs: number;
}

/** Fixed-window rate limiter (atomic INCR + PEXPIRE). */
export async function rateLimit(
  redis: Redis,
  keys: Keyspace,
  bucket: string,
  subject: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const [allowed, count, ttl] = await runScript<[number, number, number]>(
    redis,
    RATE_LIMIT,
    [keys.rateLimit(bucket, subject)],
    [limit, windowMs],
  );
  return { allowed: allowed === 1, count, retryAfterMs: Math.max(0, ttl) };
}
