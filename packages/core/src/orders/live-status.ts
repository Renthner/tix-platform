import { invoices, orderAdjustments, orders, tickets } from '@tix/db';
import type { OrderStatus } from '@tix/shared';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { CoreContext } from '../context';

/**
 * Light state of an order for the polling order page: everything a payment, a cancellation or
 * the document worker changes, no matter which path did it (bank matching, PayPal capture, admin
 * "Record payment", auto-cancel …). Three indexed lookups – cheap enough to be polled.
 */
export interface OrderLiveStatus {
  status: OrderStatus;
  amountPaid: number;
  /** `<id>:<status>` of the open (PROPOSED/CONFIRMED) additional payment, or null. */
  adjustment: string | null;
  validTickets: number;
  invoices: number;
}

export async function getOrderLiveStatus(
  ctx: CoreContext,
  orderId: string,
): Promise<OrderLiveStatus | null> {
  const [[order], [adjustment], [ticketRow], [invoiceRow]] = await Promise.all([
    ctx.db
      .select({ status: orders.status, amountPaid: orders.amountPaid })
      .from(orders)
      .where(eq(orders.id, orderId)),
    ctx.db
      .select({ id: orderAdjustments.id, status: orderAdjustments.status })
      .from(orderAdjustments)
      .where(
        and(
          eq(orderAdjustments.orderId, orderId),
          inArray(orderAdjustments.status, ['PROPOSED', 'CONFIRMED']),
        ),
      )
      .limit(1),
    ctx.db
      .select({ n: count() })
      .from(tickets)
      .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'VALID'))),
    ctx.db.select({ n: count() }).from(invoices).where(eq(invoices.orderId, orderId)),
  ]);
  if (!order) return null;
  return {
    status: order.status,
    amountPaid: order.amountPaid,
    adjustment: adjustment ? `${adjustment.id}:${adjustment.status}` : null,
    validTickets: ticketRow?.n ?? 0,
    invoices: invoiceRow?.n ?? 0,
  };
}
