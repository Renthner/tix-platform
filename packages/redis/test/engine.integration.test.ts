/**
 * Integration tests for the Lua locking and waiting-room scripts against a real Redis.
 * Uses TEST_REDIS_URL (throw-away Redis, TIX_TEST_THROWAWAY=1) and an isolated random key prefix that is deleted afterwards.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueEngine, SeatLockEngine, createKeyspace, rateLimit } from '../src';

const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)('redis engines (integration)', () => {
  const prefix = `test${randomUUID().slice(0, 8)}`;
  const keys = createKeyspace(prefix);
  let redis: Redis;
  let seats: SeatLockEngine;
  let queue: QueueEngine;
  const future = () => Date.now() + 60_000;

  beforeAll(() => {
    redis = new Redis(url!, { enableAutoPipelining: true, maxRetriesPerRequest: 2 });
    seats = new SeatLockEngine(redis, keys);
    queue = new QueueEngine(redis, keys);
  });

  afterAll(async () => {
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);
      if (found.length > 0) await redis.del(...found);
      cursor = next;
    } while (cursor !== '0');
    await redis.quit();
  });

  const event = () => randomUUID();

  // ── Seats ─────────────────────────────────────────────────────────────────
  it('lets exactly one of 300 concurrent sessions lock the same seat', async () => {
    const e = event();
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        seats.lockSeats({
          eventId: e,
          sessionId: `s${i}`,
          seatIds: ['A1'],
          expiresAt: future(),
          maxPerSession: 10,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'LOCKED')).toHaveLength(299);
  });

  it('locks multiple seats all-or-nothing', async () => {
    const e = event();
    await seats.lockSeats({
      eventId: e,
      sessionId: 'a',
      seatIds: ['2'],
      expiresAt: future(),
      maxPerSession: 0,
    });
    const r = await seats.lockSeats({
      eventId: e,
      sessionId: 'b',
      seatIds: ['1', '2', '3'],
      expiresAt: future(),
      maxPerSession: 0,
    });
    expect(r).toEqual({ ok: false, reason: 'LOCKED', seatId: '2' });
    expect(await seats.sessionSeatIds(e, 'b')).toEqual([]);
    expect(await redis.exists(keys.seatLock(e, '1'), keys.seatLock(e, '3'))).toBe(0);
  });

  it('rejects seats mirrored as sold / blocked', async () => {
    const e = event();
    await seats.replaceInventory(e, 1, { S1: 'S', B1: 'B' }, {});
    const r = await seats.lockSeats({
      eventId: e,
      sessionId: 'a',
      seatIds: ['B1'],
      expiresAt: future(),
      maxPerSession: 0,
    });
    expect(r).toEqual({ ok: false, reason: 'UNAVAILABLE', seatId: 'B1' });
    expect(await seats.inventoryVersion(e)).toBe(1);
  });

  it('enforces the per-session limit across seats and standing spots', async () => {
    const e = event();
    await seats.replaceInventory(e, 1, {}, { GA: 100 });
    await seats.holdGeneralAdmission({
      eventId: e,
      sessionId: 'a',
      sectionId: 'GA',
      delta: 2,
      expiresAt: future(),
      maxPerSession: 4,
    });
    const ok = await seats.lockSeats({
      eventId: e,
      sessionId: 'a',
      seatIds: ['1', '2'],
      expiresAt: future(),
      maxPerSession: 4,
    });
    expect(ok.ok).toBe(true);
    const tooMany = await seats.lockSeats({
      eventId: e,
      sessionId: 'a',
      seatIds: ['3'],
      expiresAt: future(),
      maxPerSession: 4,
    });
    expect(tooMany).toEqual({ ok: false, reason: 'LIMIT_EXCEEDED', held: 4 });
  });

  it('releases only seats owned by the session', async () => {
    const e = event();
    await seats.lockSeats({
      eventId: e,
      sessionId: 'a',
      seatIds: ['1'],
      expiresAt: future(),
      maxPerSession: 0,
    });
    expect(await seats.releaseSeats(e, 'b', ['1'])).toEqual([]);
    expect(await seats.releaseSeats(e, 'a', ['1'])).toEqual(['1']);
    expect(await seats.lockedSeatIds(e)).toEqual([]);
  });

  it('sweeps expired locks and extends locks for the payment grace period', async () => {
    const e = event();
    await seats.lockSeats({
      eventId: e,
      sessionId: 'a',
      seatIds: ['1'],
      expiresAt: Date.now() + 80,
      maxPerSession: 0,
    });
    await seats.lockSeats({
      eventId: e,
      sessionId: 'b',
      seatIds: ['2'],
      expiresAt: Date.now() + 80,
      maxPerSession: 0,
    });
    expect(await seats.extendCart(e, 'b', Date.now() + 60_000)).toBe(1);
    await sleep(150);
    expect(await seats.sweepExpiredSeats(e)).toEqual(['1']);
    expect(await seats.lockedSeatIds(e)).toEqual(['2']);
    // expired seat can be taken by someone else
    const r = await seats.lockSeats({
      eventId: e,
      sessionId: 'c',
      seatIds: ['1'],
      expiresAt: future(),
      maxPerSession: 0,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects locks into an expired cart', async () => {
    const r = await seats.lockSeats({
      eventId: event(),
      sessionId: 'a',
      seatIds: ['1'],
      expiresAt: Date.now() - 1,
      maxPerSession: 0,
    });
    expect(r).toEqual({ ok: false, reason: 'CART_EXPIRED' });
  });

  // ── General admission ────────────────────────────────────────────────────
  it('never over-holds a standing section under concurrency', async () => {
    const e = event();
    await seats.replaceInventory(e, 1, {}, { GA: 5 });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        seats.holdGeneralAdmission({
          eventId: e,
          sessionId: `s${i}`,
          sectionId: 'GA',
          delta: 1,
          expiresAt: future(),
          maxPerSession: 10,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(await seats.generalAdmissionRemaining(e)).toEqual({ GA: 0 });
  });

  it('releases GA holds by delta and on expiry', async () => {
    const e = event();
    await seats.replaceInventory(e, 1, {}, { GA: 10 });
    await seats.holdGeneralAdmission({
      eventId: e,
      sessionId: 'a',
      sectionId: 'GA',
      delta: 3,
      expiresAt: future(),
      maxPerSession: 0,
    });
    const less = await seats.holdGeneralAdmission({
      eventId: e,
      sessionId: 'a',
      sectionId: 'GA',
      delta: -1,
      expiresAt: future(),
      maxPerSession: 0,
    });
    expect(less).toEqual({ ok: true, held: 2, remaining: 8 });
    await seats.holdGeneralAdmission({
      eventId: e,
      sessionId: 'b',
      sectionId: 'GA',
      delta: 4,
      expiresAt: Date.now() + 50,
      maxPerSession: 0,
    });
    await sleep(100);
    expect(await seats.sweepExpiredGeneralAdmission(e)).toEqual({ GA: 8 });
    expect(await seats.sessionGeneralAdmission(e, 'b')).toEqual({});
  });

  // ── Waiting room ─────────────────────────────────────────────────────────
  it('issues FIFO numbers and admits in batches up to the threshold', async () => {
    const e = event();
    for (let i = 1; i <= 5; i += 1) {
      expect(await queue.join(e, `s${i}`, false)).toEqual({ status: 'waiting', number: i });
    }
    expect(await queue.join(e, 's1', false)).toEqual({ status: 'waiting', number: 1 });
    const timing = { activeWindowMs: 60_000, claimWindowMs: 60_000 };
    const first = await queue.admit(e, { ...timing, batchSize: 2, threshold: 3 });
    expect(first).toEqual({ admitted: ['s1', 's2'], cursor: 2 });
    // 2 admitted (pending claim) occupy capacity → only one more slot
    const second = await queue.admit(e, { ...timing, batchSize: 2, threshold: 3 });
    expect(second).toEqual({ admitted: ['s3'], cursor: 3 });
    expect(
      await queue.claim(e, 's1', { claimWindowMs: 60_000, jti: 'j1', passTtlMs: 60_000 }),
    ).toBe(true);
    expect(await queue.passId(e, 's1')).toBe('j1');
    expect(
      await queue.claim(e, 's5', { claimWindowMs: 60_000, jti: 'j5', passTtlMs: 60_000 }),
    ).toBe(false);
  });

  it('draws the lobby exactly once, including late joiners', async () => {
    const e = event();
    for (const s of ['a', 'b', 'c'])
      expect(await queue.join(e, s, true)).toEqual({ status: 'lobby' });
    const order = ['c', 'a', 'b'];
    await queue.join(e, 'late', true);
    expect(await queue.draw(e, order)).toBe(4);
    expect(await queue.draw(e, order)).toBe(-1);
    const numbers = await Promise.all(['c', 'a', 'b', 'late'].map((s) => queue.position(e, s)));
    expect(numbers.map((n) => n.number)).toEqual([1, 2, 3, 4]);
    // after the draw, joining goes straight to the waiting line
    expect(await queue.join(e, 'after', true)).toEqual({ status: 'waiting', number: 5 });
  });

  it('only lets newcomers in directly when nobody is waiting and capacity is free', async () => {
    const e = event();
    const params = {
      activeWindowMs: 60_000,
      claimWindowMs: 60_000,
      threshold: 1,
      passTtlMs: 60_000,
      bypassQueue: false,
    };
    expect(await queue.enterDirectly(e, 'a', { ...params, jti: 'ja' })).toBe(true);
    expect(await queue.enterDirectly(e, 'b', { ...params, jti: 'jb' })).toBe(false); // threshold reached
    expect(await queue.enterDirectly(e, 'vip', { ...params, jti: 'jv', bypassQueue: true })).toBe(
      true,
    );
    expect(await queue.ping(e, 'a')).toBe(true);
    expect(await queue.ping(e, 'b')).toBe(false);
  });

  it('rate-limits per window', async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1)
      results.push(await rateLimit(redis, keys, 'lock', 'ip1', 3, 10_000));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });
});
