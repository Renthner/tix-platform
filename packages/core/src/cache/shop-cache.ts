import type { Redis } from '@tix/redis';
import type { CoreContext } from '../context';
import { coreLog } from '../log';
import { invalidateSettings } from '../settings';
import {
  TagCache,
  attachCacheSync,
  publishInvalidation,
  type CacheStats,
  type CacheSyncHandle,
} from './tag-cache';

/**
 * Process-wide shop data cache (see docs/ARCHITECTURE.md "Shop data cache").
 *
 * What may be cached: rarely changing data that is identical for every visitor (events, venues,
 * seat map geometry, prices, info boxes, queue display texts). What must NOT be cached: seat
 * status, counters, carts, queue positions/passes, sessions – and nothing that depends on the
 * current time (sale state is computed from the cached timestamps at render time).
 *
 * Every code path that changes cached data invalidates the matching tags AFTER its database
 * transaction committed: `await invalidateShopCache(ctx, eventTags(eventId))`.
 */

export const SHOP_TAGS = {
  /** Any change of the event catalogue: slugs, status, visibility, order, prices, ... */
  events: 'events',
  venues: 'venues',
  media: 'media',
  symbols: 'symbols',
  /** Waiting-room configuration and announcements. */
  queue: 'queue',
  /** One event: its row, price categories, tariffs, pricing matrix, seat map, info boxes. */
  event: (eventId: string) => `event:${eventId}`,
} as const;

/** Tags to invalidate when anything about one event changed (the safe default for event edits). */
export const eventTags = (eventId: string): string[] => [
  SHOP_TAGS.events,
  SHOP_TAGS.event(eventId),
];

const g = globalThis as typeof globalThis & {
  __tixShopCache?: TagCache;
  __tixShopCacheSync?: CacheSyncHandle;
};

/** Singleton on `globalThis`: Next.js bundles `@tix/core` into several module layers. */
export const shopCache: TagCache = (g.__tixShopCache ??= new TagCache({
  maxEntries: 500,
  defaultTtlMs: 60_000,
  unsyncedTtlMs: 3_000,
}));

/**
 * Evicts `tags` in this process at once and tells every other process (web replicas) over
 * Redis pub/sub. Never throws: the data change is already committed, a failed publish only
 * means other processes fall back to the safety TTL (and the failure is logged).
 */
export async function invalidateShopCache(
  ctx: Pick<CoreContext, 'publisher' | 'channels'>,
  what: readonly string[] | 'all',
): Promise<void> {
  if (what === 'all') shopCache.clear();
  else shopCache.invalidate(what);
  try {
    await publishInvalidation(ctx.publisher, ctx.channels.shopCacheInvalidation(), what);
  } catch (error) {
    coreLog.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'shop cache: could not publish invalidation (other instances rely on the safety TTL)',
    );
  }
}

/**
 * Connects this process to the cross-process invalidation channel (idempotent). Also drops the
 * in-process settings cache when any process saves a setting. `extra` runs for setting changes.
 */
export function startShopCacheSync(
  ctx: Pick<CoreContext, 'channels'>,
  subscriber: Redis,
  extra?: { onSettingChanged?: (setting: string | undefined) => void },
): void {
  if (g.__tixShopCacheSync) return;
  g.__tixShopCacheSync = attachCacheSync(shopCache, {
    subscriber,
    cacheChannel: ctx.channels.shopCacheInvalidation(),
    configChannel: ctx.channels.configInvalidation(),
    onConfigChanged: (setting) => {
      invalidateSettings(setting);
      // Secret settings live under their own cache key.
      if (setting) invalidateSettings(`secret:${setting}`);
      try {
        extra?.onSettingChanged?.(setting);
      } catch (error) {
        coreLog.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'shop cache: setting change hook failed',
        );
      }
    },
  });
}

export function shopCacheStats(): CacheStats {
  return shopCache.stats();
}
