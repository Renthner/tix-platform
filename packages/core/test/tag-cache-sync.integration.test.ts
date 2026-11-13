/**
 * Cross-process invalidation of the shop data cache over Redis pub/sub (throw-away Redis):
 * two independent caches + subscriber connections stand in for two web instances.
 */
import { randomUUID } from 'node:crypto';
import { loadRootEnv } from '@tix/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TagCache,
  attachCacheSync,
  publishInvalidation,
  type CacheSyncHandle,
} from '../src/cache/tag-cache';

loadRootEnv();
const redisUrl = process.env.TEST_REDIS_URL;

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.skipIf(!redisUrl)('TagCache cross-instance sync (integration)', () => {
  const channel = `t${randomUUID().slice(0, 8)}:ch:cache`;
  const configChannel = `t${randomUUID().slice(0, 8)}:ch:config`;
  let publisher: Redis;
  const redisClients: Redis[] = [];
  const handles: CacheSyncHandle[] = [];

  const instance = async (onConfigChanged?: (s: string | undefined) => void) => {
    const subscriber = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    redisClients.push(subscriber);
    const cache = new TagCache({ defaultTtlMs: 60_000 });
    const handle = attachCacheSync(cache, {
      subscriber,
      cacheChannel: channel,
      configChannel,
      onConfigChanged,
    });
    handles.push(handle);
    await until(() => cache.state === 'synced');
    return { cache, subscriber };
  };

  beforeAll(() => {
    publisher = new Redis(redisUrl!);
    redisClients.push(publisher);
  });

  afterAll(async () => {
    for (const h of handles) h.close();
    await Promise.all(redisClients.map((c) => c.quit().catch(() => c.disconnect())));
  });

  it('is degraded (bypassed) until the subscription is confirmed, then synced', async () => {
    const subscriber = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    redisClients.push(subscriber);
    const cache = new TagCache();
    const handle = attachCacheSync(cache, { subscriber, cacheChannel: channel });
    handles.push(handle);
    expect(cache.state).toBe('degraded');
    await until(() => cache.state === 'synced');
  });

  it('a tag invalidation published by one instance evicts the entry on the other', async () => {
    const a = await instance();
    const b = await instance();
    const loadB = vi.fn(async () => 'v');
    await b.cache.get('event-row:1', loadB, { tags: ['event:1'] });
    await b.cache.get('event-row:1', loadB, { tags: ['event:1'] });
    expect(loadB).toHaveBeenCalledTimes(1);

    // "Instance A" saves an event and publishes after its commit.
    a.cache.invalidate(['event:1']);
    await publishInvalidation(publisher, channel, ['event:1']);
    await until(() => b.cache.stats().invalidations === 1);

    await b.cache.get('event-row:1', loadB, { tags: ['event:1'] });
    expect(loadB).toHaveBeenCalledTimes(2);
  });

  it('an unrelated tag leaves other entries alone; "all" flushes everything', async () => {
    const b = await instance();
    const load = vi.fn(async () => 'v');
    await b.cache.get('k', load, { tags: ['event:1'] });
    await publishInvalidation(publisher, channel, ['event:2']);
    await until(() => b.cache.stats().invalidations === 1);
    await b.cache.get('k', load, { tags: ['event:1'] });
    expect(load).toHaveBeenCalledTimes(1);

    const flushesBefore = b.cache.stats().flushes;
    await publishInvalidation(publisher, channel, 'all');
    await until(() => b.cache.stats().flushes > flushesBefore);
    await b.cache.get('k', load, { tags: ['event:1'] });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('forwards setting changes of the config channel', async () => {
    const seen: (string | undefined)[] = [];
    await instance((s) => seen.push(s));
    seen.length = 0; // the initial "everything may have changed" call
    await publisher.publish(configChannel, JSON.stringify({ setting: 'branding' }));
    await until(() => seen.length === 1);
    expect(seen).toEqual(['branding']);
    await publisher.publish(configChannel, '{}');
    await until(() => seen.length === 2);
    expect(seen[1]).toBeUndefined();
  });

  it('survives garbage on the channel by flushing', async () => {
    const b = await instance();
    await b.cache.get('k', async () => 1, { tags: ['x'] });
    await publisher.publish(channel, 'not json');
    await until(() => b.cache.stats().entries === 0);
  });

  it('a lost connection degrades the cache (bypass); reconnecting flushes it and re-syncs', async () => {
    const b = await instance();
    const load = vi.fn(async () => 'v');
    await b.cache.get('k', load, { tags: ['x'] });
    expect(b.cache.stats().entries).toBe(1);

    // Connection drop with automatic reconnect (the realistic failure).
    b.subscriber.disconnect(true);
    await until(() => b.cache.state === 'degraded');
    expect(b.cache.stats().entries).toBe(0);
    await b.cache.get('k', load, { tags: ['x'] });
    expect(b.cache.stats().bypasses).toBeGreaterThan(0);

    await until(() => b.cache.state === 'synced');
    // Subscription works again after the reconnect.
    await b.cache.get('k', load, { tags: ['x'] });
    const before = b.cache.stats().invalidations;
    await publishInvalidation(publisher, channel, ['x']);
    await until(() => b.cache.stats().invalidations > before);
    expect(b.cache.stats().entries).toBe(0);
  });
});
