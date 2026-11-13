import { createChannels } from '@tix/redis';
import { Redis } from 'ioredis';
import { publishInvalidation } from '../cache/tag-cache';

/**
 * Tells every running web instance to drop its shop data cache (`all`). For CLI scripts that
 * change shop data directly in the database (demo data). Best effort: without a Redis
 * connection (or when it fails) nothing happens – running instances then pick the change up
 * when their short safety TTLs expire.
 */
export async function flushShopCacheBestEffort(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    const prefix = process.env.REDIS_KEY_PREFIX || 'tix';
    await publishInvalidation(redis, createChannels(prefix).shopCacheInvalidation(), 'all');
    console.log('[cache] published a full shop cache invalidation');
  } catch {
    console.log('[cache] Redis not reachable – running instances refresh within seconds anyway');
  } finally {
    redis.disconnect();
  }
}
