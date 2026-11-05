import { randomInt } from 'node:crypto';
import { events } from '@tix/db';
import { eq } from 'drizzle-orm';
import type { CoreContext } from './context';
import { ACTIVE_WINDOW_MS, computeSaleState, effectiveQueueConfig, saleOpensAt } from './events';
import { publishQueueUpdate, publishSeatDelta, publishSessionMessage } from './realtime';

/**
 * Periodic jobs executed by the worker (single leader at a time):
 *  - sweepExpiredLocks: frees expired seat locks / GA holds and broadcasts the release
 *  - tickWaitingRooms:  draws lobbies at T-0 and admits the next batch per event
 */

export async function sweepExpiredLocks(ctx: CoreContext, now = Date.now()): Promise<number> {
  const eventIds = await ctx.redis.smembers(ctx.keys.activeLockEvents());
  let released = 0;
  for (const eventId of eventIds) {
    const [seatIds, ga] = await Promise.all([
      ctx.seats.sweepExpiredSeats(eventId, now),
      ctx.seats.sweepExpiredGeneralAdmission(eventId, now),
    ]);
    released += seatIds.length;
    if (seatIds.length > 0 || Object.keys(ga).length > 0) {
      await publishSeatDelta(ctx, {
        eventId,
        seats: seatIds.map((id) => [id, 'F']),
        ga: Object.keys(ga).length ? ga : undefined,
      });
    }
    const [locks, holds] = await Promise.all([
      ctx.redis.zcard(ctx.keys.seatLockExpiries(eventId)),
      ctx.redis.zcard(ctx.keys.generalAdmissionExpiries(eventId)),
    ]);
    if (locks === 0 && holds === 0) await ctx.redis.srem(ctx.keys.activeLockEvents(), eventId);
  }
  return released;
}

/** Cryptographically fair Fisher–Yates shuffle (lottery mode). */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const CURSOR_BROADCAST_INTERVAL_MS = 5_000;
const lastBroadcast = new Map<string, number>();

export async function tickWaitingRooms(ctx: CoreContext, now = Date.now()): Promise<void> {
  const eventIds = await ctx.redis.smembers(ctx.keys.activeQueueEvents());
  for (const eventId of eventIds) {
    const [event] = await ctx.db.select().from(events).where(eq(events.id, eventId));
    if (!event) {
      await ctx.redis.srem(ctx.keys.activeQueueEvents(), eventId);
      continue;
    }
    const state = computeSaleState(event, new Date(now));
    if (state === 'ENDED' || state === 'CANCELLED' || state === 'NOT_PUBLISHED') {
      await ctx.queue.reset(eventId);
      await ctx.redis.srem(ctx.keys.activeQueueEvents(), eventId);
      continue;
    }
    const config = await effectiveQueueConfig(ctx, eventId);
    const snapshot = await ctx.queue.snapshot(eventId);

    // T-0: move the pre-registration lobby into the queue (once).
    const opensAt = saleOpensAt(event);
    if (
      snapshot.drawnAt === null &&
      (state === 'ON_SALE' || state === 'PRESALE') &&
      (!opensAt || now >= opensAt.getTime())
    ) {
      const members = await ctx.queue.lobbyMembers(eventId);
      const ordered = config.admissionOrder === 'RANDOMIZED' ? shuffle(members) : members;
      const drawn = await ctx.queue.draw(eventId, ordered, now);
      if (drawn >= 0) await publishQueueUpdate(ctx, { type: 'state', eventId, state: 'DRAWN' });
    }

    if (state !== 'ON_SALE' && state !== 'PRESALE') continue;
    if (config.isPaused) continue;

    const state2 = await ctx.redis.hget(ctx.keys.queueState(eventId), 'lastTickAt');
    if (state2 && now - Number(state2) < config.admissionIntervalSeconds * 1000) {
      await maybeBroadcastCursor(ctx, eventId, now);
      continue;
    }
    const claimWindowMs = Math.max(60_000, config.admissionIntervalSeconds * 2000);
    const result = await ctx.queue.admit(eventId, {
      now,
      batchSize: config.admissionBatchSize,
      threshold: config.activeSessionThreshold,
      activeWindowMs: ACTIVE_WINDOW_MS,
      claimWindowMs,
    });
    for (const sessionId of result.admitted) {
      await publishSessionMessage(ctx, sessionId, {
        type: 'admitted',
        eventId,
        claimWithinSeconds: Math.floor(claimWindowMs / 1000),
      });
    }
    await maybeBroadcastCursor(ctx, eventId, now, result.admitted.length > 0);
  }
}

async function maybeBroadcastCursor(
  ctx: CoreContext,
  eventId: string,
  now: number,
  force = false,
): Promise<void> {
  if (!force && now - (lastBroadcast.get(eventId) ?? 0) < CURSOR_BROADCAST_INTERVAL_MS) return;
  lastBroadcast.set(eventId, now);
  const snapshot = await ctx.queue.snapshot(eventId);
  await publishQueueUpdate(ctx, {
    type: 'cursor',
    eventId,
    cursor: snapshot.cursor,
    waiting: snapshot.waiting,
    at: now,
  });
}
