import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createKeyspace } from '@tix/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRootEnv } from '@tix/db';
import { withMutex } from '../src/banking/runs';

loadRootEnv();
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)('withMutex', () => {
  let redis: Redis;
  const keys = createKeyspace(`t${randomUUID().slice(0, 8)}`);
  const ctx = () => ({ redis, keys });

  beforeAll(() => {
    redis = new Redis(redisUrl!);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('keeps the lock past its TTL while the body runs (lease renewal)', async () => {
    const outcome = await withMutex(ctx(), 'renew', 300, async () => {
      await sleep(900);
      // still ours: a competitor is rejected although 3 TTLs have passed
      expect(await withMutex(ctx(), 'renew', 300, async () => 'x')).toBeNull();
      return 'done';
    });
    expect(outcome).toEqual({ value: 'done' });
    // released afterwards
    expect(await withMutex(ctx(), 'renew', 300, async () => 'again')).toEqual({ value: 'again' });
  });

  it('never deletes a lock that now belongs to somebody else', async () => {
    const key = keys.mutex('foreign');
    await withMutex(ctx(), 'foreign', 5_000, async () => {
      await redis.set(key, 'someone-else', 'PX', 5_000);
    });
    expect(await redis.get(key)).toBe('someone-else');
    await redis.del(key);
  });

  it('releases the lock when the body throws', async () => {
    await expect(
      withMutex(ctx(), 'throws', 5_000, async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(await withMutex(ctx(), 'throws', 5_000, async () => 1)).toEqual({ value: 1 });
  });
});
