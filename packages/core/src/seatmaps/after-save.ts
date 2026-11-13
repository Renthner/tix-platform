import { eventTags, invalidateShopCache } from '../cache/shop-cache';
import type { CoreContext } from '../context';
import { getEventById } from '../events';
import { rebuildInventory } from '../inventory';
import { publishSeatDelta } from '../realtime';
import { forgetSeatMapVersion } from './public';
import type { SaveSeatMapResult } from './document';

/**
 * Side effects after an EVENT seat map was saved (outside the DB transaction):
 *  - rebuild the Redis inventory mirror (blocked / removed seats),
 *  - force-release cart locks on seats that were removed or blocked,
 *  - tell all connected browsers to reload the plan (new version).
 */
export async function afterSeatMapSaved(
  ctx: CoreContext,
  result: Extract<SaveSeatMapResult, { ok: true }>,
): Promise<void> {
  if (result.kind !== 'EVENT' || !result.eventId) return;
  const event = await getEventById(ctx, result.eventId);
  if (event.seatMapId) forgetSeatMapVersion(event.seatMapId);
  // Plan geometry, prices and the event page price range changed: drop them on every instance.
  await invalidateShopCache(ctx, eventTags(event.id));
  await rebuildInventory(ctx, event);
  const doc = await ctx.seats.takenSeats(event.id);
  const forced = [
    ...result.removedSeatIds,
    ...result.blockedSeatIds.filter((id) => doc[id] === 'B'),
  ];
  await ctx.seats.forceRelease(event.id, forced);
  await publishSeatDelta(ctx, { eventId: event.id, seats: [], version: result.version });
}
