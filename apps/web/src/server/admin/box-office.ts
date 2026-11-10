import 'server-only';
import { DomainError } from '@tix/core';
import { orders } from '@tix/db';
import type { AdminRole } from '@tix/shared';
import { eq } from 'drizzle-orm';
import { hasRole, type AdminSession } from '@/server/auth';
import { getCore } from '@/server/core';

/** Everyone with an admin role may sell over the counter. */
export const BOX_OFFICE_ROLES: AdminRole[] = ['EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF'];

/**
 * What the signed-in admin may do at the box office:
 *  - CASH / CARD: every role;
 *  - complimentary tickets and price changes: EVENT_MANAGER / FINANCE (SUPER_ADMIN implicitly);
 *  - selling blocked (press / VIP) seats: EVENT_MANAGER only.
 */
export function boxOfficePermissions(session: AdminSession) {
  return {
    complimentary: hasRole(session, ['EVENT_MANAGER', 'FINANCE']),
    priceOverride: hasRole(session, ['EVENT_MANAGER', 'FINANCE']),
    blockedSeats: hasRole(session, ['EVENT_MANAGER']),
  };
}

/**
 * Orders the admin may open through the box-office routes: non-online orders. Door staff only
 * see their own sales; managers and finance see all.
 */
export async function loadBoxOfficeOrder(session: AdminSession, orderId: string) {
  const [order] = await getCore()
    .db.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      channel: orders.channel,
      status: orders.status,
      createdByUserId: orders.createdByUserId,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  const allowed =
    order &&
    order.channel !== 'ONLINE' &&
    (hasRole(session, ['EVENT_MANAGER', 'FINANCE']) || order.createdByUserId === session.userId);
  if (!order || !allowed) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  return order;
}
