import type { Redis } from 'ioredis';
import type { Keyspace } from './keys';

/**
 * Shop presence ("who is in the shop right now"), for the admin dashboard only. Independent of the
 * waiting room: `queue:active` (pass holders, 2-minute window) keeps deciding admission.
 *
 * Per event a ZSET sessionId → last heartbeat (epoch ms), plus one shop-wide ZSET for the
 * overview (a shopper looking at two events counts once there). Clients heartbeat every ~15-20 s;
 * a session counts while its last heartbeat is younger than `PRESENCE_WINDOW_MS`; a closing
 * socket removes the session immediately. Entries older than `PRESENCE_RETENTION_MS` are pruned.
 */
export const PRESENCE_WINDOW_MS = 45_000;
export const PRESENCE_RETENTION_MS = 5 * 60_000;

export class PresenceTracker {
  constructor(
    private readonly redis: Redis,
    private readonly keys: Keyspace,
  ) {}

  /** Records a heartbeat of `sessionId` in the given events (and the shop-wide set). */
  async touch(sessionId: string, eventIds: readonly string[], now = Date.now()): Promise<void> {
    const pipeline = this.redis.pipeline();
    const cutoff = now - PRESENCE_RETENTION_MS;
    const ttlMs = PRESENCE_RETENTION_MS * 2;
    const keys = [...new Set(eventIds)].map((id) => this.keys.presence(id));
    keys.push(this.keys.presenceShop());
    for (const key of keys) {
      pipeline.zadd(key, now, sessionId);
      pipeline.zremrangebyscore(key, '-inf', cutoff);
      pipeline.pexpire(key, ttlMs);
    }
    await pipeline.exec();
  }

  /** Removes the session (socket closed / tab left). `eventIds` null = only the shop-wide set. */
  async remove(sessionId: string, eventIds: readonly string[], shopWide = true): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const id of new Set(eventIds)) pipeline.zrem(this.keys.presence(id), sessionId);
    if (shopWide) pipeline.zrem(this.keys.presenceShop(), sessionId);
    await pipeline.exec();
  }

  /** Sessions with a heartbeat inside the window, per event and shop-wide. */
  async counts(
    eventIds: readonly string[],
    now = Date.now(),
  ): Promise<{ byEvent: Map<string, number>; shop: number }> {
    const since = now - PRESENCE_WINDOW_MS;
    const pipeline = this.redis.pipeline();
    for (const id of eventIds) pipeline.zcount(this.keys.presence(id), since, '+inf');
    pipeline.zcount(this.keys.presenceShop(), since, '+inf');
    const replies = (await pipeline.exec()) ?? [];
    const n = (i: number) => Number(replies[i]?.[1] ?? 0) || 0;
    return {
      byEvent: new Map(eventIds.map((id, i) => [id, n(i)])),
      shop: n(eventIds.length),
    };
  }
}
