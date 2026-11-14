/**
 * Stale-while-revalidate single-value cache (used for the live shop default language).
 *
 *  - Once a value is known `get()` returns it immediately; an expired TTL triggers one
 *    background refresh (never more than one in flight).
 *  - Only the cold path (no value yet) waits, bounded by `coldTimeoutMs`, then `fallback`.
 *  - `apply()` sets a value authoritatively and bumps a generation counter so a refresh that
 *    started earlier cannot write its (older) result back.
 *  - A loader returning `undefined` means "nothing to report" (value kept).
 *  - `onHealth` fires only on state changes (ok -> failing, failing -> ok).
 */
export interface SwrCacheOptions<T> {
  ttlMs: number;
  coldTimeoutMs: number;
  fallback: T;
  load: () => Promise<T | undefined>;
  onValue?: (value: T) => void;
  onHealth?: (ok: boolean, error?: unknown) => void;
  now?: () => number;
}

export interface SwrCache<T> {
  get(): Promise<T>;
  apply(value: T): void;
  peek(): T | undefined;
}

export function createSwrCache<T>(options: SwrCacheOptions<T>): SwrCache<T> {
  const now = options.now ?? Date.now;
  let value: T | undefined;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let generation = 0;
  let inflight: Promise<void> | undefined;
  let failing = false;

  const store = (next: T) => {
    value = next;
    options.onValue?.(next);
  };

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    const started = generation;
    inflight = (async () => {
      try {
        const next = await options.load();
        if (failing) {
          failing = false;
          options.onHealth?.(true);
        }
        if (next !== undefined && started === generation) store(next);
      } catch (error) {
        if (!failing) {
          failing = true;
          options.onHealth?.(false, error);
        }
      } finally {
        checkedAt = now();
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    async get() {
      if (value !== undefined) {
        if (now() - checkedAt >= options.ttlMs) void refresh();
        return value;
      }
      // Cold and the last attempt just failed: don't make every request wait again.
      if (!inflight && now() - checkedAt < options.ttlMs) return options.fallback;
      const pending = refresh();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.coldTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        await Promise.race([pending, timeout]);
      } finally {
        clearTimeout(timer);
      }
      return value ?? options.fallback;
    },
    apply(next) {
      generation += 1;
      store(next);
      checkedAt = now();
    },
    peek: () => value,
  };
}

/** Request header the proxy uses to hand the default language it applied to the layout. */
export const DEFAULT_LOCALE_HEADER = 'x-tix-default-locale';
