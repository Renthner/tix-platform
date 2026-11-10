import {
  invoiceLines,
  invoices,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  refundItems,
  type Executor,
} from '@tix/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { findActiveInvoice } from '../invoices';
import { orderNetPaid } from './net-paid';

export { orderNetPaid };

/**
 * What earlier credit notes already credited per fee line. The credit note lines are the source
 * of truth (they hold the exact net/tax split); only orders without an invoice fall back to
 * the money allocation in `refund_items`.
 */
export async function creditedFeeAmounts(
  tx: Executor,
  orderId: string,
  feeIds: string[],
): Promise<Map<string, { gross: number; net: number; tax: number }>> {
  // Only credit notes of the invoice in force count: an earlier, fully reversed invoice
  // (bank allocation reversed, order paid again) must not reduce what can be credited now.
  const invoice = await findActiveInvoice(tx, orderId);
  const result = new Map<string, { gross: number; net: number; tax: number }>();
  if (feeIds.length === 0) return result;
  if (invoice) {
    const rows = await tx
      .select({
        feeId: invoiceLines.orderFeeId,
        gross: sql<number>`-SUM(${invoiceLines.totalGross})::int`,
        net: sql<number>`-SUM(${invoiceLines.totalNet})::int`,
        tax: sql<number>`-SUM(${invoiceLines.totalTax})::int`,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(
        and(
          eq(invoices.type, 'CREDIT_NOTE'),
          eq(invoices.correctsInvoiceId, invoice.id),
          inArray(invoiceLines.orderFeeId, feeIds),
        ),
      )
      .groupBy(invoiceLines.orderFeeId);
    for (const r of rows) result.set(r.feeId!, { gross: r.gross, net: r.net, tax: r.tax });
    return result;
  }
  const rows = await tx
    .select({ feeId: refundItems.orderFeeId, total: sql<number>`SUM(${refundItems.amount})::int` })
    .from(refundItems)
    .where(inArray(refundItems.orderFeeId, feeIds))
    .groupBy(refundItems.orderFeeId);
  for (const r of rows) result.set(r.feeId!, { gross: r.total, net: 0, tax: 0 });
  return result;
}

interface CreditOrder {
  id: string;
  status: string;
  totalGross: number;
  paidCycle: number;
}

/**
 * What the customer still owes for the order as it is now: the order total while nothing was
 * cancelled; after (partial) cancellations the CONFIRMED tickets plus the fee remainder no
 * credit note has credited (fees kept on purpose stay part of it).
 */
export async function orderLiveTotal(db: Executor, order: CreditOrder): Promise<number> {
  if (order.status === 'PAID') return order.totalGross;
  const [items] = await db
    .select({ sum: sql<number>`coalesce(sum(${orderItems.priceGross}), 0)::int` })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, 'CONFIRMED')));
  const fees = await db.select().from(orderFees).where(eq(orderFees.orderId, order.id));
  const credited = await creditedFeeAmounts(
    db,
    order.id,
    fees.map((f) => f.id),
  );
  const feeRemainder = fees.reduce(
    (sum, f) => sum + Math.max(0, f.totalGross - (credited.get(f.id)?.gross ?? 0)),
    0,
  );
  return (items?.sum ?? 0) + feeRemainder;
}

/** Shortfall written off when the order was settled in its current paid cycle (0 = none). */
export async function currentWriteOff(db: Executor, order: CreditOrder): Promise<number> {
  const [row] = await db
    .select({ shortfall: sql<number>`COALESCE((${orderHistory.data}->>'shortfall')::int, 0)` })
    .from(orderHistory)
    .where(
      and(
        eq(orderHistory.orderId, order.id),
        eq(orderHistory.type, 'shortfall_written_off'),
        sql`COALESCE((${orderHistory.data}->>'paidCycle')::int, 0) = ${order.paidCycle}`,
      ),
    )
    .orderBy(desc(orderHistory.createdAt))
    .limit(1);
  return row?.shortfall ?? 0;
}

/** Excess of net money over what is owed (`live` minus a written-off shortfall), never negative. */
export function creditOf(netPaid: number, live: number, writeOff: number): number {
  return Math.max(0, netPaid - Math.max(0, live - writeOff));
}

/**
 * Overpayment of an order that can be credited against an additional price (tariff change) or
 * paid back: net money above the live value of the order, taking a written-off shortfall of the
 * current paid cycle into account. Also meaningful after (partial) cancellations.
 */
export async function orderCredit(
  db: Executor,
  order: CreditOrder,
): Promise<{ netPaid: number; credit: number }> {
  const [netPaid, live, writeOff] = await Promise.all([
    orderNetPaid(db, order.id),
    orderLiveTotal(db, order),
    currentWriteOff(db, order),
  ]);
  return { netPaid, credit: creditOf(netPaid, live, writeOff) };
}

/** Read-only variant for pages (loads the order itself). */
export async function getOrderCredit(
  db: Executor,
  orderId: string,
): Promise<{ netPaid: number; credit: number }> {
  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      totalGross: orders.totalGross,
      paidCycle: orders.paidCycle,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  return order ? orderCredit(db, order) : { netPaid: 0, credit: 0 };
}
