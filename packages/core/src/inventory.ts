import { orderItems, seatMapSections, seats } from '@tix/db';
import { INVENTORY_HOLDING_ITEM_STATUSES } from '@tix/shared';
import type { TakenCode } from '@tix/redis';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { CoreContext } from './context';
import { DomainError } from './context';
import type { EventRow } from './events';
import { seatMapVersion } from './seatmaps/public';

/**
 * Keeps the Redis inventory mirror (taken seats + sellable GA capacity) in sync with
 * PostgreSQL. The mirror is rebuilt whenever it is missing or was built from an older seat
 * map version; order transitions (Phase 3) update single seats incrementally.
 */
export async function rebuildInventory(ctx: CoreContext, event: EventRow): Promise<number> {
  if (!event.seatMapId) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  const version = await seatMapVersion(ctx, event.seatMapId);

  const [seatRows, items, sections] = await Promise.all([
    ctx.db
      .select({ id: seats.id, blockReason: seats.blockReason, removedAt: seats.removedAt })
      .from(seats)
      .where(and(eq(seats.seatMapId, event.seatMapId))),
    ctx.db
      .select({ seatId: orderItems.seatId, status: orderItems.status })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.eventId, event.id),
          isNotNull(orderItems.seatId),
          inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
        ),
      ),
    ctx.db
      .select({
        id: seatMapSections.id,
        capacity: seatMapSections.capacity,
        allocated: seatMapSections.allocatedCount,
      })
      .from(seatMapSections)
      .where(
        and(
          eq(seatMapSections.seatMapId, event.seatMapId),
          eq(seatMapSections.type, 'STANDING'),
          eq(seatMapSections.isActive, true),
          isNull(seatMapSections.removedAt),
        ),
      ),
  ]);

  const taken: Record<string, TakenCode> = {};
  for (const s of seatRows) {
    if (s.removedAt) taken[s.id] = 'X';
    else if (s.blockReason) taken[s.id] = 'B';
  }
  for (const item of items) {
    if (item.seatId) taken[item.seatId] = item.status === 'CONFIRMED' ? 'S' : 'R';
  }
  const ga: Record<string, number> = {};
  for (const s of sections) ga[s.id] = Math.max(0, (s.capacity ?? 0) - s.allocated);

  await ctx.seats.replaceInventory(event.id, version, taken, ga);
  return version;
}

/** Ensures the mirror matches the current seat map version; returns that version. */
export async function ensureInventory(ctx: CoreContext, event: EventRow): Promise<number> {
  if (!event.seatMapId) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  const [mirrored, current] = await Promise.all([
    ctx.seats.inventoryVersion(event.id),
    seatMapVersion(ctx, event.seatMapId),
  ]);
  if (mirrored === current) return current;
  return rebuildInventory(ctx, event);
}
