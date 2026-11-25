/**
 * The sweeper's "untrack idle event" step must never drop an event that got a lock in between:
 * registration happens inside the lock scripts and the untrack re-checks emptiness atomically.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SeatLockEngine, createKeyspace } from '../src';

const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)('active lock events tracking (integration)', () => {
  const prefix = `test${randomUUID().slice(0, 8)}`;
  const keys = createKeyspace(prefix);
  let redis: Redis;
  let seats: SeatLockEngine;
  const future = () => Date.now() + 60_000;

  beforeAll(() => {
    redis = new Redis(url!, { maxRetriesPerRequest: 2 });
    seats = new SeatLockEngine(redis, keys);
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

  const tracked = (e: string) => redis.sismember(keys.activeLockEvents(), e);

  it('registers the event atomically with a seat lock', async () => {
    const e = randomUUID();
    await seats.lockSeats({
      eventId: e,
      sessionId: 's1',
      seatIds: ['a'],
      expiresAt: future(),
      maxPerSession: 0,
    });
    expect(await tracked(e)).toBe(1);
  });

  it('registers the event with a GA hold (and not on release)', async () => {
    const e = randomUUID();
    await redis.hset(keys.generalAdmissionAvailable(e), 'sec', '10');
    await seats.holdGeneralAdmission({
      eventId: e,
      sessionId: 's1',
      sectionId: 'sec',
      delta: 2,
      expiresAt: future(),
      maxPerSession: 0,
    });
    expect(await tracked(e)).toBe(1);
  });

  it('does not untrack an event that was locked after the sweep (interleaving)', async () => {
    const e = randomUUID();
    // Sweeper step 1: the sweep found the event empty (nothing locked yet) ...
    expect(await redis.zcard(keys.seatLockExpiries(e))).toBe(0);
    // ... a buyer locks + registers in between ...
    await seats.lockSeats({
      eventId: e,
      sessionId: 's1',
      seatIds: ['a'],
      expiresAt: future(),
      maxPerSession: 0,
    });
    // ... sweeper step 2 (untrack) must now be a no-op.
    expect(await seats.untrackIfIdle(e)).toBe(false);
    expect(await tracked(e)).toBe(1);
  });

  it('re-registers the event when a cart is extended (grace period)', async () => {
    const e = randomUUID();
    await seats.lockSeats({
      eventId: e,
      sessionId: 's1',
      seatIds: ['a'],
      expiresAt: future(),
      maxPerSession: 0,
    });
    await redis.srem(keys.activeLockEvents(), e);
    expect(await seats.extendCart(e, 's1', future() + 60_000)).toBe(1);
    expect(await tracked(e)).toBe(1);

    // nothing to extend (unknown session): the event is not registered
    const other = randomUUID();
    expect(await seats.extendCart(other, 's9', future())).toBe(0);
    expect(await tracked(other)).toBe(0);
  });

  it('untracks an idle event and keeps one with only GA holds', async () => {
    const idle = randomUUID();
    await redis.sadd(keys.activeLockEvents(), idle);
    expect(await seats.untrackIfIdle(idle)).toBe(true);
    expect(await tracked(idle)).toBe(0);

    const ga = randomUUID();
    await redis.hset(keys.generalAdmissionAvailable(ga), 'sec', '5');
    await seats.holdGeneralAdmission({
      eventId: ga,
      sessionId: 's1',
      sectionId: 'sec',
      delta: 1,
      expiresAt: future(),
      maxPerSession: 0,
    });
    expect(await seats.untrackIfIdle(ga)).toBe(false);
    expect(await tracked(ga)).toBe(1);
  });
});
