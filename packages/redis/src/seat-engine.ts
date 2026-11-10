import type { Redis } from 'ioredis';
import type { Keyspace } from './keys';
import { defineScript, runScript } from './script';

/**
 * Atomic seat & general-admission locking (Redis + Lua).
 *
 * Invariants guaranteed by the scripts:
 *  - a seat is locked by at most one cart session (SET … PXAT per seat key)
 *  - multi-seat requests are all-or-nothing
 *  - seats mirrored as taken (sold / reserved / blocked / removed) can never be locked
 *  - a session never exceeds its per-event ticket limit (seats + GA spots)
 *  - GA holds never exceed the sellable capacity of a standing section
 * PostgreSQL remains the final authority (partial unique index) when orders are created.
 */

// KEYS: taken, expiries, cartSeats, gaHolds, lock_1..lock_n
// ARGV: sid, expiresAt, maxPerSession, now, seat_1..seat_n
const LOCK_SEATS = defineScript(
  'lockSeats',
  `
local sid = ARGV[1]
local exp = tonumber(ARGV[2])
local maxSeats = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local n = #KEYS - 4
if exp <= now then return {-3, 0} end
local fresh = 0
for i = 1, n do
  local seat = ARGV[4 + i]
  if redis.call('HEXISTS', KEYS[1], seat) == 1 then return {-1, i} end
  local owner = redis.call('GET', KEYS[4 + i])
  if owner and owner ~= sid then return {-2, i} end
  if not owner then fresh = fresh + 1 end
end
if maxSeats > 0 then
  local held = redis.call('SCARD', KEYS[3])
  local ga = redis.call('HGET', KEYS[4], sid)
  if ga then for _, c in pairs(cjson.decode(ga)) do held = held + c end end
  if held + fresh > maxSeats then return {-4, held} end
end
for i = 1, n do
  redis.call('SET', KEYS[4 + i], sid, 'PXAT', exp)
  redis.call('ZADD', KEYS[2], exp, ARGV[4 + i])
  redis.call('SADD', KEYS[3], ARGV[4 + i])
end
redis.call('PEXPIREAT', KEYS[3], exp + 60000)
return {1, fresh}
`,
);

// KEYS: expiries, cartSeats, lock_1..lock_n   ARGV: sid, seat_1..seat_n
const RELEASE_SEATS = defineScript(
  'releaseSeats',
  `
local released = {}
for i = 1, #KEYS - 2 do
  local seat = ARGV[1 + i]
  if redis.call('GET', KEYS[2 + i]) == ARGV[1] then
    redis.call('DEL', KEYS[2 + i])
    redis.call('ZREM', KEYS[1], seat)
    table.insert(released, seat)
  end
  redis.call('SREM', KEYS[2], seat)
end
return released
`,
);

// KEYS: expiries, cartSeats, gaHolds, gaExpiries, lock_1..lock_n   ARGV: sid, newExp, seat_1..seat_n
const EXTEND_CART = defineScript(
  'extendCart',
  `
local sid = ARGV[1]
local exp = tonumber(ARGV[2])
local extended = 0
for i = 1, #KEYS - 4 do
  if redis.call('GET', KEYS[4 + i]) == sid then
    redis.call('PEXPIREAT', KEYS[4 + i], exp)
    redis.call('ZADD', KEYS[1], exp, ARGV[2 + i])
    extended = extended + 1
  end
end
if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('PEXPIREAT', KEYS[2], exp + 60000) end
local ga = 0
if redis.call('HEXISTS', KEYS[3], sid) == 1 then
  redis.call('ZADD', KEYS[4], exp, sid)
  ga = 1
end
return {extended, ga}
`,
);

// KEYS: expiries   ARGV: now, limit
const SWEEP_SEATS = defineScript(
  'sweepSeats',
  `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #expired > 0 then redis.call('ZREM', KEYS[1], unpack(expired)) end
return expired
`,
);

// KEYS: gaAvailable, gaHeld, gaHolds, gaExpiries, cartSeats
// ARGV: sid, sectionId, delta, expiresAt, now, maxPerSession
const HOLD_GA = defineScript(
  'holdGeneralAdmission',
  `
local sid = ARGV[1]
local section = ARGV[2]
local delta = tonumber(ARGV[3])
local exp = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local maxSeats = tonumber(ARGV[6])
if delta > 0 and exp <= now then return {-3, 0, 0} end
local holds = {}
local raw = redis.call('HGET', KEYS[3], sid)
if raw then holds = cjson.decode(raw) end
local mine = tonumber(holds[section] or 0)
if delta < 0 and -delta > mine then delta = -mine end
local available = redis.call('HGET', KEYS[1], section)
if not available then return {-1, mine, 0} end
available = tonumber(available)
local held = tonumber(redis.call('HGET', KEYS[2], section) or '0')
if delta > 0 then
  if held + delta > available then return {-5, mine, available - held} end
  if maxSeats > 0 then
    local total = redis.call('SCARD', KEYS[5])
    for _, c in pairs(holds) do total = total + c end
    if total + delta > maxSeats then return {-4, mine, available - held} end
  end
end
mine = mine + delta
if mine > 0 then holds[section] = mine else holds[section] = nil end
held = redis.call('HINCRBY', KEYS[2], section, delta)
if next(holds) == nil then
  redis.call('HDEL', KEYS[3], sid)
  redis.call('ZREM', KEYS[4], sid)
else
  redis.call('HSET', KEYS[3], sid, cjson.encode(holds))
  redis.call('ZADD', KEYS[4], exp, sid)
end
return {1, mine, available - held}
`,
);

// KEYS: gaAvailable, gaHeld, gaHolds, gaExpiries
// ARGV: sid, sectionId_1, n_1, sectionId_2, n_2 …
// Converts a session's GA holds into ordered spots: the hold is consumed and the sellable
// capacity reduced in one step (the DB allocation is the authority; this keeps the mirror
// consistent). Returns {1} or {-1, sectionIndex} if a hold is smaller than requested.
const COMMIT_GA = defineScript(
  'commitGeneralAdmission',
  `
local sid = ARGV[1]
local holds = {}
local raw = redis.call('HGET', KEYS[3], sid)
if raw then holds = cjson.decode(raw) end
for i = 2, #ARGV, 2 do
  local section = ARGV[i]
  local n = tonumber(ARGV[i + 1])
  if tonumber(holds[section] or 0) < n then return {-1, (i - 2) / 2} end
end
for i = 2, #ARGV, 2 do
  local section = ARGV[i]
  local n = tonumber(ARGV[i + 1])
  holds[section] = tonumber(holds[section]) - n
  if holds[section] <= 0 then holds[section] = nil end
  redis.call('HINCRBY', KEYS[2], section, -n)
  redis.call('HINCRBY', KEYS[1], section, -n)
end
if next(holds) == nil then
  redis.call('HDEL', KEYS[3], sid)
  redis.call('ZREM', KEYS[4], sid)
else
  redis.call('HSET', KEYS[3], sid, cjson.encode(holds))
end
return {1}
`,
);

// KEYS: gaAvailable, gaHeld, gaHolds, gaExpiries   ARGV: now, limit
// Returns flat list: sectionId, remaining, sectionId, remaining …
const SWEEP_GA = defineScript(
  'sweepGeneralAdmission',
  `
local expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local touched = {}
for _, sid in ipairs(expired) do
  local raw = redis.call('HGET', KEYS[3], sid)
  if raw then
    for section, count in pairs(cjson.decode(raw)) do
      redis.call('HINCRBY', KEYS[2], section, -count)
      touched[section] = true
    end
    redis.call('HDEL', KEYS[3], sid)
  end
  redis.call('ZREM', KEYS[4], sid)
end
local result = {}
for section, _ in pairs(touched) do
  local available = tonumber(redis.call('HGET', KEYS[1], section) or '0')
  local held = tonumber(redis.call('HGET', KEYS[2], section) or '0')
  table.insert(result, section)
  table.insert(result, available - held)
end
return result
`,
);

export type LockFailureReason = 'UNAVAILABLE' | 'LOCKED' | 'CART_EXPIRED' | 'LIMIT_EXCEEDED';

export type LockResult =
  | { ok: true; newlyLocked: number }
  | { ok: false; reason: LockFailureReason; seatId?: string; held?: number };

export type GaHoldResult =
  | { ok: true; held: number; remaining: number }
  | {
      ok: false;
      reason: 'NOT_READY' | 'SOLD_OUT' | 'CART_EXPIRED' | 'LIMIT_EXCEEDED';
      held: number;
      remaining: number;
    };

export type TakenCode = 'S' | 'R' | 'B' | 'X';

export class SeatLockEngine {
  constructor(
    private readonly redis: Redis,
    private readonly keys: Keyspace,
  ) {}

  async lockSeats(params: {
    eventId: string;
    sessionId: string;
    seatIds: string[];
    expiresAt: number;
    maxPerSession: number;
    now?: number;
  }): Promise<LockResult> {
    const { eventId, sessionId, seatIds } = params;
    if (seatIds.length === 0) return { ok: true, newlyLocked: 0 };
    const k = this.keys;
    const [status, detail] = await runScript<[number, number]>(
      this.redis,
      LOCK_SEATS,
      [
        k.seatsTaken(eventId),
        k.seatLockExpiries(eventId),
        k.cartSeats(eventId, sessionId),
        k.generalAdmissionHolds(eventId),
        ...seatIds.map((id) => k.seatLock(eventId, id)),
      ],
      [sessionId, params.expiresAt, params.maxPerSession, params.now ?? Date.now(), ...seatIds],
    );
    if (status === 1) {
      await this.redis.sadd(k.activeLockEvents(), eventId);
      return { ok: true, newlyLocked: detail };
    }
    switch (status) {
      case -1:
        return { ok: false, reason: 'UNAVAILABLE', seatId: seatIds[detail - 1] };
      case -2:
        return { ok: false, reason: 'LOCKED', seatId: seatIds[detail - 1] };
      case -3:
        return { ok: false, reason: 'CART_EXPIRED' };
      default:
        return { ok: false, reason: 'LIMIT_EXCEEDED', held: detail };
    }
  }

  /** Releases the given seats if (and only if) they are locked by this session. */
  async releaseSeats(eventId: string, sessionId: string, seatIds: string[]): Promise<string[]> {
    if (seatIds.length === 0) return [];
    const k = this.keys;
    return runScript<string[]>(
      this.redis,
      RELEASE_SEATS,
      [
        k.seatLockExpiries(eventId),
        k.cartSeats(eventId, sessionId),
        ...seatIds.map((id) => k.seatLock(eventId, id)),
      ],
      [sessionId, ...seatIds],
    );
  }

  /** Moves all locks + GA holds of a session in one event to a new expiry (payment grace). */
  async extendCart(eventId: string, sessionId: string, expiresAt: number): Promise<number> {
    const k = this.keys;
    const seatIds = await this.redis.smembers(k.cartSeats(eventId, sessionId));
    const [extended] = await runScript<[number, number]>(
      this.redis,
      EXTEND_CART,
      [
        k.seatLockExpiries(eventId),
        k.cartSeats(eventId, sessionId),
        k.generalAdmissionHolds(eventId),
        k.generalAdmissionExpiries(eventId),
        ...seatIds.map((id) => k.seatLock(eventId, id)),
      ],
      [sessionId, expiresAt, ...seatIds],
    );
    return extended;
  }

  /** Removes locks whose expiry passed and returns the released seat ids. */
  sweepExpiredSeats(eventId: string, now = Date.now(), limit = 5_000): Promise<string[]> {
    return runScript<string[]>(
      this.redis,
      SWEEP_SEATS,
      [this.keys.seatLockExpiries(eventId)],
      [now, limit],
    );
  }

  async holdGeneralAdmission(params: {
    eventId: string;
    sessionId: string;
    sectionId: string;
    delta: number;
    expiresAt: number;
    maxPerSession: number;
    now?: number;
  }): Promise<GaHoldResult> {
    const { eventId, sessionId } = params;
    const k = this.keys;
    const [status, held, remaining] = await runScript<[number, number, number]>(
      this.redis,
      HOLD_GA,
      [
        k.generalAdmissionAvailable(eventId),
        k.generalAdmissionHeld(eventId),
        k.generalAdmissionHolds(eventId),
        k.generalAdmissionExpiries(eventId),
        k.cartSeats(eventId, sessionId),
      ],
      [
        sessionId,
        params.sectionId,
        params.delta,
        params.expiresAt,
        params.now ?? Date.now(),
        params.maxPerSession,
      ],
    );
    if (status === 1) {
      if (params.delta > 0) await this.redis.sadd(k.activeLockEvents(), eventId);
      return { ok: true, held, remaining };
    }
    const reason =
      status === -1
        ? 'NOT_READY'
        : status === -3
          ? 'CART_EXPIRED'
          : status === -4
            ? 'LIMIT_EXCEEDED'
            : 'SOLD_OUT';
    return { ok: false, reason, held, remaining };
  }

  /** Releases expired GA holds; returns the new remaining capacity of touched sections. */
  async sweepExpiredGeneralAdmission(
    eventId: string,
    now = Date.now(),
    limit = 5_000,
  ): Promise<Record<string, number>> {
    const k = this.keys;
    const flat = await runScript<(string | number)[]>(
      this.redis,
      SWEEP_GA,
      [
        k.generalAdmissionAvailable(eventId),
        k.generalAdmissionHeld(eventId),
        k.generalAdmissionHolds(eventId),
        k.generalAdmissionExpiries(eventId),
      ],
      [now, limit],
    );
    const result: Record<string, number> = {};
    for (let i = 0; i < flat.length; i += 2) result[String(flat[i])] = Number(flat[i + 1]);
    return result;
  }

  /** Seats of this session whose lock is still owned by it. */
  async sessionSeatIds(eventId: string, sessionId: string): Promise<string[]> {
    const k = this.keys;
    const members = await this.redis.smembers(k.cartSeats(eventId, sessionId));
    if (members.length === 0) return [];
    const owners = await this.redis.mget(members.map((id) => k.seatLock(eventId, id)));
    return members.filter((_, i) => owners[i] === sessionId);
  }

  async sessionGeneralAdmission(
    eventId: string,
    sessionId: string,
  ): Promise<Record<string, number>> {
    const raw = await this.redis.hget(this.keys.generalAdmissionHolds(eventId), sessionId);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  }

  /** Currently locked seat ids (any session). */
  lockedSeatIds(eventId: string, now = Date.now()): Promise<string[]> {
    return this.redis.zrangebyscore(this.keys.seatLockExpiries(eventId), `(${now}`, '+inf');
  }

  /** Live cart holds: seats with an unexpired lock and general-admission spots held in carts. */
  async liveHoldCounts(
    eventId: string,
    now = Date.now(),
  ): Promise<{ seats: number; gaSpots: number }> {
    const k = this.keys;
    const [seatCount, held] = await Promise.all([
      this.redis.zcount(k.seatLockExpiries(eventId), `(${now}`, '+inf'),
      this.redis.hvals(k.generalAdmissionHeld(eventId)),
    ]);
    return { seats: seatCount, gaSpots: held.reduce((sum, v) => sum + (Number(v) || 0), 0) };
  }

  /** `liveHoldCounts` for many events in one Redis round trip (dashboard overview). */
  async liveHoldCountsMany(
    eventIds: readonly string[],
    now = Date.now(),
  ): Promise<Map<string, { seats: number; gaSpots: number }>> {
    const result = new Map<string, { seats: number; gaSpots: number }>();
    if (eventIds.length === 0) return result;
    const pipeline = this.redis.pipeline();
    for (const id of eventIds) {
      pipeline.zcount(this.keys.seatLockExpiries(id), `(${now}`, '+inf');
      pipeline.hvals(this.keys.generalAdmissionHeld(id));
    }
    const replies = (await pipeline.exec()) ?? [];
    eventIds.forEach((id, i) => {
      const seats = Number(replies[i * 2]?.[1] ?? 0) || 0;
      const held = (replies[i * 2 + 1]?.[1] as string[] | undefined) ?? [];
      result.set(id, { seats, gaSpots: held.reduce((sum, v) => sum + (Number(v) || 0), 0) });
    });
    return result;
  }

  async takenSeats(eventId: string): Promise<Record<string, TakenCode>> {
    return (await this.redis.hgetall(this.keys.seatsTaken(eventId))) as Record<string, TakenCode>;
  }

  /** Remaining sellable GA spots per section (DB capacity − held in carts). */
  async generalAdmissionRemaining(eventId: string): Promise<Record<string, number>> {
    const k = this.keys;
    const [available, held] = await Promise.all([
      this.redis.hgetall(k.generalAdmissionAvailable(eventId)),
      this.redis.hgetall(k.generalAdmissionHeld(eventId)),
    ]);
    const result: Record<string, number> = {};
    for (const [section, value] of Object.entries(available)) {
      result[section] = Math.max(0, Number(value) - Number(held[section] ?? 0));
    }
    return result;
  }

  /** Inventory mirror version (seat map version it was built from) or null. */
  async inventoryVersion(eventId: string): Promise<number | null> {
    const v = await this.redis.get(this.keys.inventoryReady(eventId));
    return v === null ? null : Number(v);
  }

  /** Atomically replaces the inventory mirror (taken seats + sellable GA capacity). */
  async replaceInventory(
    eventId: string,
    version: number,
    taken: Record<string, TakenCode>,
    gaAvailable: Record<string, number>,
  ): Promise<void> {
    const k = this.keys;
    const tx = this.redis.multi();
    tx.del(k.seatsTaken(eventId), k.generalAdmissionAvailable(eventId));
    if (Object.keys(taken).length > 0) tx.hset(k.seatsTaken(eventId), taken);
    if (Object.keys(gaAvailable).length > 0) {
      tx.hset(
        k.generalAdmissionAvailable(eventId),
        Object.fromEntries(Object.entries(gaAvailable).map(([s, n]) => [s, String(n)])),
      );
    }
    tx.set(k.inventoryReady(eventId), String(version));
    await tx.exec();
  }

  /** Marks single seats as taken / available again (order and admin transitions). */
  async setTaken(eventId: string, changes: Record<string, TakenCode | null>): Promise<void> {
    const k = this.keys;
    const add = Object.entries(changes).filter((e): e is [string, TakenCode] => e[1] !== null);
    const remove = Object.entries(changes)
      .filter(([, v]) => v === null)
      .map(([id]) => id);
    const tx = this.redis.multi();
    if (add.length > 0) tx.hset(k.seatsTaken(eventId), Object.fromEntries(add));
    if (remove.length > 0) tx.hdel(k.seatsTaken(eventId), ...remove);
    await tx.exec();
  }

  /** Turns a session's GA holds into ordered spots (see COMMIT_GA). */
  async commitGeneralAdmission(
    eventId: string,
    sessionId: string,
    quantities: Record<string, number>,
  ): Promise<boolean> {
    const entries = Object.entries(quantities).filter(([, n]) => n > 0);
    if (entries.length === 0) return true;
    const k = this.keys;
    const [status] = await runScript<[number, number?]>(
      this.redis,
      COMMIT_GA,
      [
        k.generalAdmissionAvailable(eventId),
        k.generalAdmissionHeld(eventId),
        k.generalAdmissionHolds(eventId),
        k.generalAdmissionExpiries(eventId),
      ],
      [sessionId, ...entries.flatMap(([section, n]) => [section, n])],
    );
    return status === 1;
  }

  /** Gives ordered GA spots back to the sellable capacity (order cancelled / expired). */
  async releaseGeneralAdmission(
    eventId: string,
    quantities: Record<string, number>,
  ): Promise<void> {
    const entries = Object.entries(quantities).filter(([, n]) => n > 0);
    if (entries.length === 0) return;
    const tx = this.redis.multi();
    for (const [section, n] of entries)
      tx.hincrby(this.keys.generalAdmissionAvailable(eventId), section, n);
    await tx.exec();
  }

  /** Force-releases seat locks regardless of owner (seat removed / blocked by an admin). */
  async forceRelease(eventId: string, seatIds: string[]): Promise<void> {
    if (seatIds.length === 0) return;
    const k = this.keys;
    await this.redis
      .multi()
      .del(...seatIds.map((id) => k.seatLock(eventId, id)))
      .zrem(k.seatLockExpiries(eventId), ...seatIds)
      .exec();
  }
}
