import { describe, expect, it, vi } from 'vitest';
import { TagCache } from '../src/cache/tag-cache';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const opts = (tags: string[] = ['t'], ttlMs?: number) => ({ tags, ttlMs });

describe('TagCache', () => {
  it('serves hits from memory and counts them', async () => {
    const cache = new TagCache();
    const loader = vi.fn(async () => ({ n: 1 }));
    const a = await cache.get('k', loader, opts());
    const b = await cache.get('k', loader, opts());
    expect(a).toBe(b);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  it('single-flight: concurrent misses share one load', async () => {
    const cache = new TagCache();
    const gate = deferred<string>();
    const loader = vi.fn(() => gate.promise);
    const all = [1, 2, 3, 4, 5].map(() => cache.get('k', loader, opts()));
    gate.resolve('v');
    expect(await Promise.all(all)).toEqual(['v', 'v', 'v', 'v', 'v']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats().coalesced).toBe(4);
  });

  it('does not cache failures and lets every waiter see the error', async () => {
    const cache = new TagCache();
    const gate = deferred<string>();
    const first = cache.get('k', () => gate.promise, opts());
    const second = cache.get('k', () => Promise.resolve('other'), opts());
    gate.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(await cache.get('k', async () => 'ok', opts())).toBe('ok');
  });

  it('survives a loader that throws synchronously', async () => {
    const cache = new TagCache();
    await expect(
      cache.get(
        'k',
        (() => {
          throw new Error('sync');
        }) as () => Promise<string>,
        opts(),
      ),
    ).rejects.toThrow('sync');
    expect(await cache.get('k', async () => 'ok', opts())).toBe('ok');
  });

  it('expires entries after their TTL', async () => {
    let now = 1_000;
    const cache = new TagCache({ now: () => now, defaultTtlMs: 60_000 });
    cache.setState('synced');
    const loader = vi.fn(async () => now);
    await cache.get('k', loader, opts(['t'], 5_000));
    now += 4_999;
    await cache.get('k', loader, opts(['t'], 5_000));
    expect(loader).toHaveBeenCalledTimes(1);
    now += 2;
    await cache.get('k', loader, opts(['t'], 5_000));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('evicts by tag only', async () => {
    const cache = new TagCache();
    const a = vi.fn(async () => 'a');
    const b = vi.fn(async () => 'b');
    await cache.get('a', a, opts(['event:1', 'events']));
    await cache.get('b', b, opts(['event:2', 'events']));
    cache.invalidate(['event:1']);
    await cache.get('a', a, opts(['event:1', 'events']));
    await cache.get('b', b, opts(['event:2', 'events']));
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    cache.invalidate(['events']);
    await cache.get('b', b, opts(['event:2', 'events']));
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('derives tags and TTL from the loaded value; ttl 0 is not stored', async () => {
    const cache = new TagCache();
    const loader = vi.fn(async () => ({ id: '7', keep: false }));
    const o = {
      tags: (v: { id: string }) => [`event:${v.id}`],
      ttlMs: (v: { keep: boolean }) => (v.keep ? 1_000 : 0),
    };
    await cache.get('k', loader, o);
    await cache.get('k', loader, o);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.stats().entries).toBe(0);

    const kept = vi.fn(async () => ({ id: '7', keep: true }));
    await cache.get('k', kept, o);
    await cache.get('k', kept, o);
    expect(kept).toHaveBeenCalledTimes(1);
    cache.invalidate(['event:7']);
    await cache.get('k', kept, o);
    expect(kept).toHaveBeenCalledTimes(2);
  });

  it('an invalidation during a load keeps the (possibly stale) result out of the cache', async () => {
    const cache = new TagCache();
    const gate = deferred<string>();
    const slow = cache.get('k', () => gate.promise, opts(['event:1']));
    cache.invalidate(['event:1']); // the change happened while the load was reading
    gate.resolve('stale');
    expect(await slow).toBe('stale'); // its own caller still gets the answer
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().discarded).toBe(1);
    expect(await cache.get('k', async () => 'fresh', opts(['event:1']))).toBe('fresh');
  });

  it('an unrelated invalidation does not discard a running load', async () => {
    const cache = new TagCache();
    const gate = deferred<string>();
    const slow = cache.get('k', () => gate.promise, opts(['event:1']));
    cache.invalidate(['event:2']);
    gate.resolve('v');
    await slow;
    expect(cache.stats().entries).toBe(1);
  });

  it('new readers do not join a load that started before an invalidation', async () => {
    const cache = new TagCache();
    const gate = deferred<string>();
    const old = cache.get('k', () => gate.promise, opts(['event:1']));
    cache.invalidate(['event:1']);
    const fresh = await cache.get('k', async () => 'fresh', opts(['event:1']));
    expect(fresh).toBe('fresh');
    gate.resolve('stale');
    await old;
    // the stale load must not overwrite the fresh entry
    expect(await cache.get('k', async () => 'never', opts(['event:1']))).toBe('fresh');
  });

  it('clear() drops everything and discards running loads', async () => {
    const cache = new TagCache();
    await cache.get('a', async () => 1, opts(['x']));
    const gate = deferred<number>();
    const running = cache.get('b', () => gate.promise, opts(['y']));
    cache.clear();
    gate.resolve(2);
    await running;
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().flushes).toBe(1);
  });

  it('keeps at most maxEntries, least recently used first', async () => {
    const cache = new TagCache({ maxEntries: 2 });
    const loader = (v: string) => vi.fn(async () => v);
    const [a, b, c] = [loader('a'), loader('b'), loader('c')];
    await cache.get('a', a, opts());
    await cache.get('b', b, opts());
    await cache.get('a', a, opts()); // touch a
    await cache.get('c', c, opts()); // evicts b
    await cache.get('a', a, opts());
    await cache.get('b', b, opts());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('unsynced caches clamp the TTL', async () => {
    let now = 0;
    const cache = new TagCache({ now: () => now, unsyncedTtlMs: 3_000 });
    const loader = vi.fn(async () => 1);
    await cache.get('k', loader, opts(['t'], 60_000));
    now = 3_001;
    await cache.get('k', loader, opts(['t'], 60_000));
    expect(loader).toHaveBeenCalledTimes(2);

    cache.setState('synced');
    await cache.get('k', loader, opts(['t'], 60_000));
    now += 10_000;
    await cache.get('k', loader, opts(['t'], 60_000));
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('degraded caches keep single-flight and store entries with a short TTL', async () => {
    let now = 0;
    const cache = new TagCache({ now: () => now, degradedTtlMs: 2_000 });
    cache.setState('synced');
    const loader = vi.fn(async () => 1);
    await cache.get('k', loader, opts(['t'], 60_000));
    expect(cache.stats().entries).toBe(1);

    // Entering the degraded state distrusts everything cached so far.
    cache.setState('degraded');
    expect(cache.stats().entries).toBe(0);

    // Concurrent misses share one load (no stampede while pub/sub is down).
    const slow = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 2;
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.get('k', slow, opts(['t'], 60_000))),
    );
    expect(results.every((v) => v === 2)).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ bypasses: 1, coalesced: 19, entries: 1 });

    // Stored, but only for the degraded TTL.
    now = 1_999;
    await cache.get('k', slow, opts(['t'], 60_000));
    expect(slow).toHaveBeenCalledTimes(1);
    now = 2_001;
    await cache.get('k', slow, opts(['t'], 60_000));
    expect(slow).toHaveBeenCalledTimes(2);

    // A load that was running when the state flipped to degraded is not stored.
    const racing = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 3;
    });
    cache.setState('synced');
    const flight = cache.get('other', racing, opts(['t'], 60_000));
    cache.setState('degraded');
    await flight;
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().discarded).toBe(1);
  });

  it('forgets the tag table instead of growing without bound', () => {
    const cache = new TagCache();
    for (let i = 0; i < 5_100; i += 1) cache.invalidate([`event:${i}`]);
    expect(cache.stats().flushes).toBeGreaterThan(0);
  });
});
