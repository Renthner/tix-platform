import { describe, expect, it, vi } from 'vitest';
import { createSwrCache } from '../src';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('createSwrCache', () => {
  it('returns the stale value immediately and refreshes once in the background', async () => {
    let t = 0;
    const first = deferred<string>();
    const loads = [Promise.resolve('a'), first.promise];
    const load = vi.fn(() => loads.shift()!);
    const cache = createSwrCache<string>({
      ttlMs: 100,
      coldTimeoutMs: 1000,
      fallback: 'en',
      load,
      now: () => t,
    });
    expect(await cache.get()).toBe('a');
    t = 200;
    expect(await cache.get()).toBe('a');
    expect(await cache.get()).toBe('a');
    expect(load).toHaveBeenCalledTimes(2);
    first.resolve('b');
    await Promise.resolve();
    await Promise.resolve();
    expect(await cache.get()).toBe('b');
  });

  it('falls back after the cold timeout and keeps loading', async () => {
    vi.useFakeTimers();
    const slow = deferred<string>();
    const cache = createSwrCache<string>({
      ttlMs: 100,
      coldTimeoutMs: 1000,
      fallback: 'en',
      load: () => slow.promise,
    });
    const p = cache.get();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('en');
    slow.resolve('de');
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.peek()).toBe('de');
    vi.useRealTimers();
  });

  it('does not let an older load overwrite a value applied meanwhile', async () => {
    const slow = deferred<string>();
    const cache = createSwrCache<string>({
      ttlMs: 100,
      coldTimeoutMs: 1,
      fallback: 'en',
      load: () => slow.promise,
    });
    await cache.get();
    cache.apply('de');
    slow.resolve('en-old');
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.peek()).toBe('de');
  });

  it('reports health changes only on transitions', async () => {
    let t = 0;
    let fail = true;
    const onHealth = vi.fn();
    const cache = createSwrCache<string>({
      ttlMs: 10,
      coldTimeoutMs: 50,
      fallback: 'en',
      load: async () => {
        if (fail) throw new Error('down');
        return 'de';
      },
      onHealth,
      now: () => t,
    });
    expect(await cache.get()).toBe('en');
    t = 20;
    await cache.get();
    await cache.get();
    expect(onHealth).toHaveBeenCalledTimes(1);
    expect(onHealth.mock.calls[0]![0]).toBe(false);
    fail = false;
    t = 40;
    await cache.get();
    await new Promise((r) => setTimeout(r, 0));
    expect(onHealth).toHaveBeenCalledTimes(2);
    expect(onHealth.mock.calls[1]![0]).toBe(true);
    expect(cache.peek()).toBe('de');
  });
});
