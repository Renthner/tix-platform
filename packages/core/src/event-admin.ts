import { events, orderItems, orders, seatMaps } from '@tix/db';
import { eq, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from './context';
import { forgetSeatMapVersion } from './seatmaps/public';

/**
 * Permanently deletes an ARCHIVED event: price categories, tariffs, fees, access codes,
 * waiting-room configuration, templates, scanner assignments, its own seat map – and all of
 * its Redis state. The slug (shop URL) becomes available again.
 *
 * Events with orders are refused: orders, invoices and payments are accounting records that
 * must be retained (GoBD, 10 years).
 */
export async function deleteArchivedEvent(
  ctx: CoreContext,
  eventId: string,
): Promise<{ slug: string; title: string }> {
  const result = await ctx.db.transaction(async (tx) => {
    const locked = await tx.execute<{
      id: string;
      status: string;
      slug: string;
      title: string;
      seat_map_id: string | null;
    }>(
      sql`SELECT id, status, slug, title, seat_map_id FROM events WHERE id = ${eventId} FOR UPDATE`,
    );
    const event = locked.rows[0];
    if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
    if (event.status !== 'ARCHIVED') {
      throw new DomainError('EVENT_NOT_ARCHIVED', 'Only archived events can be deleted', 409);
    }
    const [withOrders] = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.eventId, eventId))
      .limit(1);
    if (withOrders) {
      throw new DomainError(
        'EVENT_HAS_ORDERS',
        'This event has orders. Orders and invoices must be retained for accounting (GoBD) and cannot be deleted.',
        409,
      );
    }
    await tx.delete(events).where(eq(events.id, eventId));
    if (event.seat_map_id) await tx.delete(seatMaps).where(eq(seatMaps.id, event.seat_map_id));
    return event;
  });

  if (result.seat_map_id) forgetSeatMapVersion(result.seat_map_id);
  await purgeEventRedisState(ctx, eventId);
  return { slug: result.slug, title: result.title };
}

/** Removes every Redis key of an event (all share the `{ev:<id>}` hash tag). */
export async function purgeEventRedisState(ctx: CoreContext, eventId: string): Promise<number> {
  const pattern = `${ctx.keys.prefix}:{ev:${eventId}}:*`;
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await ctx.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    if (keys.length > 0) removed += await ctx.redis.unlink(...keys);
    cursor = next;
  } while (cursor !== '0');
  await ctx.redis
    .multi()
    .srem(ctx.keys.activeLockEvents(), eventId)
    .srem(ctx.keys.activeQueueEvents(), eventId)
    .exec();
  return removed;
}

/** True when the event has at least one order (used by the admin UI to explain the guard). */
export async function eventHasOrders(
  ctx: Pick<CoreContext, 'db'>,
  eventId: string,
): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(eq(orderItems.eventId, eventId))
    .limit(1);
  return !!row;
}
