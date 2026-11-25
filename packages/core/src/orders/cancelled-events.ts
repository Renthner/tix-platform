import { events, orderItems, type Executor } from '@tix/db';
import { and, eq, inArray } from 'drizzle-orm';

const ACTIVE_ITEM_STATUSES = ['PENDING', 'CONFIRMED'] as const;

/**
 * Orders (of the given ids) that still hold active (PENDING / CONFIRMED) items of a CANCELLED
 * event. Such an order must not be paid automatically: the money would buy tickets that are never
 * issued. Payment starts refuse it, bank matching sends it to the review queue.
 */
export async function ordersWithCancelledEventItems(
  db: Executor,
  orderIds: readonly string[],
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ orderId: orderItems.orderId })
    .from(orderItems)
    .innerJoin(events, eq(events.id, orderItems.eventId))
    .where(
      and(
        inArray(orderItems.orderId, [...orderIds]),
        inArray(orderItems.status, [...ACTIVE_ITEM_STATUSES]),
        eq(events.status, 'CANCELLED'),
      ),
    );
  return new Set(rows.map((r) => r.orderId));
}

export async function orderHasCancelledEventItems(db: Executor, orderId: string): Promise<boolean> {
  return (await ordersWithCancelledEventItems(db, [orderId])).has(orderId);
}
