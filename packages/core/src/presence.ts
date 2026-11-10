import { PresenceTracker } from '@tix/redis';
import { cartEventIds } from './cart';
import type { CoreContext } from './context';

/**
 * Shop presence for the dashboard (see `PresenceTracker`). HTTP heartbeat of shop pages without a
 * realtime socket (cart, checkout …): counts the session in the given events, by default the
 * events in its cart, and shop-wide.
 */
export async function touchShopPresence(
  ctx: CoreContext,
  sessionId: string,
  eventIds?: readonly string[],
): Promise<void> {
  const events = eventIds ?? (await cartEventIds(ctx, sessionId));
  await new PresenceTracker(ctx.redis, ctx.keys).touch(sessionId, events);
}

/** Shoppers with a heartbeat in the last 45 s, per event and shop-wide. */
export function shopPresenceCounts(ctx: CoreContext, eventIds: readonly string[]) {
  return new PresenceTracker(ctx.redis, ctx.keys).counts(eventIds);
}
