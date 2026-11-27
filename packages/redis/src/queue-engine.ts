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
 *
 * Server-wide cap (optional): the global ZSET `queueActiveAll` mirrors the per-event active and
 * admitted sets across ALL events (member `<eventId>:<sessionId>`, score = the moment the entry
 * stops counting: last heartbeat + active window, or admission + claim window). Every script
 * that touches it prunes it first (`ZREMRANGEBYSCORE -inf now`), so a leaked slot heals itself
 * after the window. It is always maintained; only the cap check is optional (cap 0 = off).
 * The key is not hash-tagged, so these scripts need a single-node Redis (see keys.ts).
 */

/** Shoppers without heartbeat for this long stop counting as active (per event and globally). */
export const QUEUE_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

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

// KEYS: waiting, admitted, state, active, activeAll
// ARGV: now, batchSize, threshold(0 = none), activeWindowMs, claimWindowMs, eventId, globalCap(0 = none)
const ADMIT = defineScript(
  'queueAdmit',
  `
local now = tonumber(ARGV[1])
local batch = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
local claimWindow = tonumber(ARGV[5])
local cap = tonumber(ARGV[7])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now - tonumber(ARGV[4]))
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - claimWindow)
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now)
local cursor = tonumber(redis.call('HGET', KEYS[3], 'cursor') or '0')
local slots = batch
if threshold > 0 then
  slots = math.min(slots, threshold - redis.call('ZCARD', KEYS[4]) - redis.call('ZCARD', KEYS[2]))
end
if cap > 0 then
  slots = math.min(slots, cap - redis.call('ZCARD', KEYS[5]))
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
  redis.call('ZADD', KEYS[5], now + claimWindow, ARGV[6] .. ':' .. sid)
  if num > cursor then cursor = num end
  table.insert(result, sid)
end
result[1] = #next / 2
result[2] = cursor
redis.call('HSET', KEYS[3], 'cursor', cursor)
return result
`,
);

// KEYS: waiting, admitted, active, pass, activeAll
// ARGV: sid, now, threshold(0 = none), activeWindowMs, claimWindowMs, jti, passTtlMs, ignoreQueue(0/1),
//       eventId, globalCap(0 = none)
// With ignoreQueue the entry is counted in activeAll but neither the queue, the event threshold
// nor the global cap can refuse it (mode OFF / VIP_CODE_ONLY / access-code bypass).
const ENTER_DIRECTLY = defineScript(
  'queueEnterDirectly',
  `
local sid = ARGV[1]
local now = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
local activeWindow = tonumber(ARGV[4])
local member = ARGV[9] .. ':' .. sid
local cap = tonumber(ARGV[10])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - activeWindow)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[5]))
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now)
if ARGV[8] ~= '1' then
  if redis.call('ZCARD', KEYS[1]) > 0 and not redis.call('ZSCORE', KEYS[2], sid) then return 0 end
  if threshold > 0 and not redis.call('ZSCORE', KEYS[3], sid) then
    local occupied = redis.call('ZCARD', KEYS[3]) + redis.call('ZCARD', KEYS[2])
    if occupied >= threshold then return 0 end
  end
  if cap > 0 and not redis.call('ZSCORE', KEYS[5], member) then
    if redis.call('ZCARD', KEYS[5]) >= cap then return 0 end
  end
end
redis.call('SET', KEYS[4], ARGV[6], 'PX', tonumber(ARGV[7]))
redis.call('ZREM', KEYS[2], sid)
redis.call('ZADD', KEYS[3], now, sid)
redis.call('ZADD', KEYS[5], now + activeWindow, member)
return 1
`,
);

// KEYS: admitted, active, pass, activeAll
// ARGV: sid, now, claimWindowMs, jti, passTtlMs, eventId, activeWindowMs
// No cap check: the slot was reserved in activeAll at admission time. The window ends exclusively
// (admittedAt + claimWindow <= now = expired), matching the inclusive prunes
// (`ZREMRANGEBYSCORE -inf ...`) of the admitted set and of activeAll: an admission whose global
// slot was already pruned can never be claimed without a cap check.
const CLAIM = defineScript(
  'queueClaim',
  `
local now = tonumber(ARGV[2])
local admittedAt = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not admittedAt or tonumber(admittedAt) <= now - tonumber(ARGV[3]) then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('SET', KEYS[3], ARGV[4], 'PX', tonumber(ARGV[5]))
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[4], now + tonumber(ARGV[7]), ARGV[6] .. ':' .. ARGV[1])
return 1
`,
);

// KEYS: active, pass, activeAll   ARGV: sid, now, eventId, activeWindowMs
const PING = defineScript(
  'queuePing',
  `
if redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[3], tonumber(ARGV[2]) + tonumber(ARGV[4]), ARGV[3] .. ':' .. ARGV[1])
return 1
`,
);

// KEYS: waiting, lobby, admitted, active, state, activeAll   ARGV: eventId
// The event's global members are removed in ZREM batches of 500 (unpack stack limit).
const RESET = defineScript(
  'queueReset',
  `
for _, key in ipairs({KEYS[3], KEYS[4]}) do
  local members = redis.call('ZRANGE', key, 0, -1)
  local batch = {}
  for _, sid in ipairs(members) do
    batch[#batch + 1] = ARGV[1] .. ':' .. sid
    if #batch == 500 then
      redis.call('ZREM', KEYS[6], unpack(batch))
      batch = {}
    end
  end
  if #batch > 0 then redis.call('ZREM', KEYS[6], unpack(batch)) end
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5])
return 1
`,
);

// KEYS: activeAll   ARGV: now
const ACTIVE_ALL_COUNT = defineScript(
  'queueActiveAllCount',
  `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]))
return redis.call('ZCARD', KEYS[1])
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
    params: QueueTiming & {
      batchSize: number;
      threshold: number;
      /** Server-wide cap of active + admitted shoppers across all events (0/undefined = off). */
      globalCap?: number;
      now?: number;
    },
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
        k.queueActiveAll(),
      ],
      [
        params.now ?? Date.now(),
        params.batchSize,
        params.threshold,
        params.activeWindowMs,
        params.claimWindowMs,
        eventId,
        params.globalCap ?? 0,
      ],
    );
    return { admitted: admitted as string[], cursor: Number(cursor) };
  }

  /**
   * Grants a pass without queueing if the event has free capacity and nobody is waiting
   * (or unconditionally with `bypassQueue`, e.g. for valid VIP codes / mode OFF).
   * `globalCap` additionally limits the active + admitted shoppers of ALL events; bypass entries
   * are counted against it but never refused.
   */
  async enterDirectly(
    eventId: string,
    sessionId: string,
    params: QueueTiming & {
      threshold: number;
      jti: string;
      passTtlMs: number;
      bypassQueue: boolean;
      /** Server-wide cap (0/undefined = off). */
      globalCap?: number;
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
        k.queueActiveAll(),
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
        eventId,
        params.globalCap ?? 0,
      ],
    );
    return result === 1;
  }

  /** Converts an admission into a pass (only within the claim window). */
  async claim(
    eventId: string,
    sessionId: string,
    params: {
      claimWindowMs: number;
      jti: string;
      passTtlMs: number;
      activeWindowMs?: number;
      now?: number;
    },
  ): Promise<boolean> {
    const k = this.keys;
    const result = await runScript<number>(
      this.redis,
      CLAIM,
      [
        k.queueAdmitted(eventId),
        k.queueActive(eventId),
        k.queuePass(eventId, sessionId),
        k.queueActiveAll(),
      ],
      [
        sessionId,
        params.now ?? Date.now(),
        params.claimWindowMs,
        params.jti,
        params.passTtlMs,
        eventId,
        params.activeWindowMs ?? QUEUE_ACTIVE_WINDOW_MS,
      ],
    );
    return result === 1;
  }

  /** Marks a pass holder as active (heartbeat). Returns false if the pass expired. */
  async ping(
    eventId: string,
    sessionId: string,
    activeWindowMs = QUEUE_ACTIVE_WINDOW_MS,
  ): Promise<boolean> {
    const k = this.keys;
    const result = await runScript<number>(
      this.redis,
      PING,
      [k.queueActive(eventId), k.queuePass(eventId, sessionId), k.queueActiveAll()],
      [sessionId, Date.now(), eventId, activeWindowMs],
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

  /**
   * Active + admitted shoppers of ALL events (what the server-wide cap compares). Prunes expired
   * entries first.
   */
  activeAllCount(now = Date.now()): Promise<number> {
    return runScript<number>(this.redis, ACTIVE_ALL_COUNT, [this.keys.queueActiveAll()], [now]);
  }

  /**
   * Clears the whole waiting room of an event (admin reset / event finished), including the
   * event's entries in the server-wide active set.
   */
  async reset(eventId: string): Promise<void> {
    const k = this.keys;
    await runScript<number>(
      this.redis,
      RESET,
      [
        k.queueWaiting(eventId),
        k.queueLobby(eventId),
        k.queueAdmitted(eventId),
        k.queueActive(eventId),
        k.queueState(eventId),
        k.queueActiveAll(),
      ],
      [eventId],
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
