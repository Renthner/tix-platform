import type { Redis } from '@tix/redis';
import { coreLog } from '../log';

/**
 * In-process data cache for rarely changing, non-personal shop data.
 *
 *  - LRU with a hard entry limit and a per-entry TTL (safety net, not the freshness mechanism),
 *  - single-flight: concurrent misses of one key share a single load,
 *  - tag based invalidation (`invalidate(['event:42'])` evicts every entry carrying that tag),
 *  - invalidation-safe loading: a load that was running while one of its tags was invalidated
 *    delivers its (possibly stale) result to its own callers but never stores it,
 *  - optional cross-process fan-out over Redis pub/sub (`attachCacheSync`): every process evicts
 *    when any process invalidates, and the whole cache is flushed whenever the subscription was
 *    interrupted (messages may have been missed).
 *
 * Cached values are shared between requests: treat them as immutable.
 */

/**
 *  - `unsynced`: no subscription configured (CLI, tests, worker without sync): TTLs are clamped
 *    to a few seconds because other processes cannot tell us about changes,
 *  - `synced`:   subscribed, invalidations from every process arrive in milliseconds,
 *  - `degraded`: subscription configured but currently down: invalidations of other processes
 *    are being missed, so entries live only a couple of seconds (single-flight still coalesces
 *    concurrent misses, so a pub/sub outage cannot turn into a database stampede).
 */
export type CacheState = 'unsynced' | 'synced' | 'degraded';

export interface CacheStats {
  state: CacheState;
  entries: number;
  hits: number;
  misses: number;
  /** Callers that joined a load already in flight (single-flight). */
  coalesced: number;
  /** Loads started while the cache was degraded (stored with the short degraded TTL). */
  bypasses: number;
  /** Loads whose result was not stored because a tag was invalidated while they ran. */
  discarded: number;
  /** `invalidate()` calls (local and received from other processes). */
  invalidations: number;
  /** Full flushes (explicit, tag table overflow, subscription reconnect). */
  flushes: number;
}

export interface CacheGetOptions<T> {
  /** Tags of the entry; a function can derive them from the loaded value (e.g. its ids). */
  tags: readonly string[] | ((value: T) => readonly string[]);
  /** Lifetime in ms (default: cache default); a function can derive it from the value. */
  ttlMs?: number | ((value: T) => number);
}

export interface TagCacheOptions {
  maxEntries?: number;
  defaultTtlMs?: number;
  /** TTL clamp while `unsynced`. */
  unsyncedTtlMs?: number;
  /** TTL clamp while `degraded` (default `DEFAULT_DEGRADED_TTL_MS`). */
  degradedTtlMs?: number;
  now?: () => number;
}

interface Entry {
  value: unknown;
  expires: number;
  tags: readonly string[];
}

/** More distinct invalidated tags than this: forget the table by flushing (bounded memory). */
const MAX_TAG_TABLE = 5_000;

/** Entry lifetime while the invalidation subscription is down (bounds staleness, keeps coalescing). */
export const DEFAULT_DEGRADED_TTL_MS = 2_000;

export class TagCache {
  readonly #maxEntries: number;
  readonly #defaultTtlMs: number;
  readonly #unsyncedTtlMs: number;
  readonly #degradedTtlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  readonly #byTag = new Map<string, Set<string>>();
  readonly #flights = new Map<string, Promise<unknown>>();
  /** Invalidation sequence; `#tagSeq` remembers when each tag was last invalidated. */
  #seq = 0;
  #floorSeq = 0;
  readonly #tagSeq = new Map<string, number>();
  #state: CacheState = 'unsynced';
  readonly #stats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    bypasses: 0,
    discarded: 0,
    invalidations: 0,
    flushes: 0,
  };

  constructor(options: TagCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 500;
    this.#defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.#unsyncedTtlMs = options.unsyncedTtlMs ?? 3_000;
    this.#degradedTtlMs = options.degradedTtlMs ?? DEFAULT_DEGRADED_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get state(): CacheState {
    return this.#state;
  }

  setState(state: CacheState): void {
    this.#state = state;
    // Entries stored under another state are not trusted any more.
    if (state === 'degraded') this.clear();
  }

  get<T>(key: string, loader: () => Promise<T>, options: CacheGetOptions<T>): Promise<T> {
    const hit = this.#entries.get(key);
    if (hit) {
      if (hit.expires > this.#now()) {
        // LRU: most recently used last.
        this.#entries.delete(key);
        this.#entries.set(key, hit);
        this.#stats.hits += 1;
        return Promise.resolve(hit.value as T);
      }
      this.#remove(key);
    }
    const running = this.#flights.get(key);
    if (running) {
      this.#stats.coalesced += 1;
      return running as Promise<T>;
    }
    this.#stats.misses += 1;
    if (this.#state === 'degraded') this.#stats.bypasses += 1;
    const startSeq = this.#seq;
    const flight: Promise<T> = Promise.resolve()
      .then(loader)
      .then((value) => {
        this.#store(key, value, options, startSeq);
        return value;
      })
      .finally(() => {
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
      });
    this.#flights.set(key, flight);
    return flight;
  }

  /** Evicts every entry carrying one of `tags` and makes running loads of them non-storing. */
  invalidate(tags: readonly string[]): void {
    this.#stats.invalidations += 1;
    this.#seq += 1;
    for (const tag of tags) {
      this.#tagSeq.set(tag, this.#seq);
      const keys = this.#byTag.get(tag);
      if (keys) for (const key of [...keys]) this.#remove(key);
    }
    // New readers must not join a load that started before the change.
    this.#flights.clear();
    if (this.#tagSeq.size > MAX_TAG_TABLE) this.clear();
  }

  /** Drops everything (and every load running right now must not store its result). */
  clear(): void {
    this.#stats.flushes += 1;
    this.#seq += 1;
    this.#floorSeq = this.#seq;
    this.#tagSeq.clear();
    this.#entries.clear();
    this.#byTag.clear();
    this.#flights.clear();
  }

  stats(): CacheStats {
    return { state: this.#state, entries: this.#entries.size, ...this.#stats };
  }

  #store<T>(key: string, value: T, options: CacheGetOptions<T>, startSeq: number): void {
    const tags = typeof options.tags === 'function' ? options.tags(value) : options.tags;
    if (startSeq < this.#floorSeq || tags.some((t) => (this.#tagSeq.get(t) ?? 0) > startSeq)) {
      this.#stats.discarded += 1;
      return;
    }
    let ttl =
      typeof options.ttlMs === 'function'
        ? options.ttlMs(value)
        : (options.ttlMs ?? this.#defaultTtlMs);
    if (this.#state === 'unsynced') ttl = Math.min(ttl, this.#unsyncedTtlMs);
    else if (this.#state === 'degraded') ttl = Math.min(ttl, this.#degradedTtlMs);
    if (!(ttl > 0)) return;
    this.#remove(key);
    this.#entries.set(key, { value, expires: this.#now() + ttl, tags });
    for (const tag of tags) {
      let keys = this.#byTag.get(tag);
      if (!keys) this.#byTag.set(tag, (keys = new Set()));
      keys.add(key);
    }
    while (this.#entries.size > this.#maxEntries) {
      this.#remove(this.#entries.keys().next().value!);
    }
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    for (const tag of entry.tags) {
      const keys = this.#byTag.get(tag);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) this.#byTag.delete(tag);
    }
  }
}

/* ---------------------------------------------------------------------------------------
 * Cross-process invalidation over Redis pub/sub
 * ------------------------------------------------------------------------------------- */

/** JSON payload on the cache channel: some tags, or everything. */
export type InvalidationMessage = { tags: string[] } | { all: true };

export async function publishInvalidation(
  publisher: Redis,
  channel: string,
  what: readonly string[] | 'all',
): Promise<void> {
  const message: InvalidationMessage = what === 'all' ? { all: true } : { tags: [...what] };
  await publisher.publish(channel, JSON.stringify(message));
}

function parseInvalidation(raw: string): InvalidationMessage | null {
  try {
    const value = JSON.parse(raw) as { tags?: unknown; all?: unknown };
    if (value.all === true) return { all: true };
    if (Array.isArray(value.tags) && value.tags.every((t) => typeof t === 'string')) {
      return { tags: value.tags as string[] };
    }
  } catch {
    // fall through
  }
  return null;
}

export interface CacheSyncOptions {
  /** Dedicated subscriber connection (SUBSCRIBE mode). */
  subscriber: Redis;
  /** Channel carrying `InvalidationMessage`s. */
  cacheChannel: string;
  /** Optional second channel for settings changes (`{ setting: key }`). */
  configChannel?: string;
  /** Called with the changed setting key, or `undefined` = all settings (after a reconnect). */
  onConfigChanged?: (setting: string | undefined) => void;
  /** Called after the cache was flushed because the subscription was (re)established. */
  onResync?: () => void;
}

export interface CacheSyncHandle {
  close(): void;
}

/**
 * Subscribes `cache` to the invalidation channel. Until the subscription is confirmed the cache
 * is `degraded` (bypassed); a connection loss degrades it again, and every (re)subscription
 * flushes it, so no invalidation can be missed unnoticed.
 */
export function attachCacheSync(cache: TagCache, options: CacheSyncOptions): CacheSyncHandle {
  const { subscriber, cacheChannel, configChannel } = options;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const onMessage = (channel: string, raw: string) => {
    if (channel === cacheChannel) {
      const message = parseInvalidation(raw);
      if (!message) {
        coreLog.warn({ channel }, 'cache sync: ignoring malformed invalidation message');
        cache.clear();
      } else if ('all' in message) cache.clear();
      else cache.invalidate(message.tags);
    } else if (configChannel && channel === configChannel) {
      let setting: string | undefined;
      try {
        const value = (JSON.parse(raw) as { setting?: unknown }).setting;
        if (typeof value === 'string') setting = value;
      } catch {
        // unknown payload: treat as "everything changed"
      }
      options.onConfigChanged?.(setting);
    }
  };

  const subscribe = () => {
    if (closed) return;
    const channels = configChannel ? [cacheChannel, configChannel] : [cacheChannel];
    subscriber.subscribe(...channels).then(
      () => {
        if (closed) return;
        // Anything cached before the subscription was confirmed may have missed a message.
        cache.clear();
        options.onConfigChanged?.(undefined);
        options.onResync?.();
        cache.setState('synced');
      },
      (error: unknown) => {
        coreLog.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'cache sync: subscribe failed, retrying',
        );
        if (closed) return;
        retry = setTimeout(subscribe, 1_000);
        retry.unref?.();
      },
    );
  };

  const onClose = () => cache.setState('degraded');
  const onReady = () => subscribe();

  cache.setState('degraded');
  subscriber.on('message', onMessage);
  subscriber.on('close', onClose);
  subscriber.on('ready', onReady);
  if (subscriber.status === 'ready') subscribe();

  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      subscriber.off('message', onMessage);
      subscriber.off('close', onClose);
      subscriber.off('ready', onReady);
      void subscriber
        .unsubscribe(cacheChannel, ...(configChannel ? [configChannel] : []))
        .catch(() => undefined);
      cache.setState('unsynced');
    },
  };
}
