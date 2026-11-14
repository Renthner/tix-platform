/**
 * Shop presence (dashboard "im Shop") against a real Redis: heartbeat window of 45 s, immediate
 * removal, pruning, shop-wide unique count. Isolated random key prefix, deleted afterwards.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRESENCE_RETENTION_MS, PRESENCE_WINDOW_MS, PresenceTracker, createKeyspace } from '../src';

const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)('shop presence (integration)', () => {
  const prefix = `test${randomUUID().slice(0, 8)}`;
  const keys = createKeyspace(prefix);
  const eventA = randomUUID();
  const eventB = randomUUID();
  let redis: Redis;
  let presence: PresenceTracker;

  beforeAll(() => {
    redis = new Redis(url!, { maxRetriesPerRequest: 2 });
    presence = new PresenceTracker(redis, keys);
  });

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    await redis.quit();
  });

  it('counts sessions with a heartbeat inside 45 s and drops the others quickly', async () => {
    const now = Date.now();
    await presence.touch('s1', [eventA], now - 10_000);
    await presence.touch('s2', [eventA], now - PRESENCE_WINDOW_MS - 1_000); // just too old
    await presence.touch('s3', [eventA, eventB], now - 44_000);
    const counts = await presence.counts([eventA, eventB], now);
    expect(counts.byEvent.get(eventA)).toBe(2); // s1 + s3
    expect(counts.byEvent.get(eventB)).toBe(1);
    expect(counts.shop).toBe(2); // each shopper once, s2 expired
  });

  it('removes a closed session at once and keeps the shop-wide entry for another open tab', async () => {
    const now = Date.now();
    await presence.touch('closing', [eventA], now);
    expect((await presence.counts([eventA], now)).byEvent.get(eventA)).toBeGreaterThanOrEqual(1);
    const before = (await presence.counts([eventA], now)).byEvent.get(eventA)!;
    await presence.remove('closing', [eventA]);
    expect((await presence.counts([eventA], now)).byEvent.get(eventA)).toBe(before - 1);

    await presence.touch('two-tabs', [eventA], now);
    await presence.remove('two-tabs', [eventA], false); // another tab of the shopper stays
    expect((await presence.counts([], now)).shop).toBeGreaterThanOrEqual(1);
  });

  it('prunes entries older than the retention on the next heartbeat', async () => {
    const now = Date.now();
    await presence.touch('ancient', [eventB], now - PRESENCE_RETENTION_MS - 60_000);
    await presence.touch('fresh', [eventB], now);
    expect(await redis.zscore(keys.presence(eventB), 'ancient')).toBeNull();
    expect(await redis.zscore(keys.presence(eventB), 'fresh')).not.toBeNull();
  });
});
