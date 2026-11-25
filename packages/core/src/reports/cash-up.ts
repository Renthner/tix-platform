import { adminUsers, orderItems, orders, refunds } from '@tix/db';
import type { PaymentMethod } from '@tix/shared';
import { and, asc, eq, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import { instantRange, parseLocalDate } from '../accounting/dates';
import { DomainError, type CoreContext } from '../context';

/**
 * Cash-up report ("Kassenabschluss") of the counter sales: orders of the box-office / admin
 * channels (never online orders, never test orders) per seller (the admin who created the order,
 * `orders.created_by_user_id`), payment method and currency.
 *
 * - `sales` = value (total gross) of the PAID / PARTIALLY_REFUNDED orders created in the range.
 * - `gross` = money actually received (`amount_paid`) on the orders created in the range (also
 *   orders that were refunded later – the money came in when they were sold).
 * - `refunded` = refunds that were completed (SUCCEEDED: PayPal executed / manual refund marked
 *   done) in the range – dated by their own completion, grouped by the order's seller and the
 *   refund's method, independent of when the order was created.
 * - `net` = gross - refunded: what the till should hold for the method.
 * - `refundsOpen` = refunds of in-scope orders requested in the range that are not paid back yet
 *   (PENDING / FAILED), also on partly refunded orders.
 * - `refundedOrders` = REFUNDED orders, `cancelled` = CANCELLED / EXPIRED orders created in the
 *   range (counted for completeness).
 * Seller and event filters apply to the order of a refund as well. Multi-event orders count in
 * full for an event filter (counter orders hold one event).
 */

export interface CashUpFilter {
  /** Inclusive local dates `YYYY-MM-DD` in `timeZone`. */
  from: string;
  to: string;
  timeZone: string;
  eventId?: string;
  /** Restrict to the orders of one seller (door staff only see their own). */
  sellerUserId?: string;
}

export interface CashUpLine {
  sellerUserId: string | null;
  sellerName: string | null;
  method: PaymentMethod;
  currency: string;
  orders: number;
  tickets: number;
  /** Value of the sold orders (total gross, cents). */
  sales: number;
  /** Money received (amount paid, cents). */
  gross: number;
  /** Refunds completed in the range (cents). */
  refunded: number;
  refundedOrders: number;
  refundedOrdersGross: number;
  /** Refunds not paid back yet (PENDING / FAILED, cents). */
  refundsOpen: number;
  cancelledOrders: number;
  cancelledGross: number;
}

export interface CashUpTotals {
  orders: number;
  tickets: number;
  sales: number;
  gross: number;
  refunded: number;
  /** gross - refunded: what is in the till for this method. */
  net: number;
  refundedOrders: number;
  refundedOrdersGross: number;
  refundsOpen: number;
  cancelledOrders: number;
  cancelledGross: number;
}

export interface CashUpReport {
  filter: CashUpFilter;
  lines: CashUpLine[];
  byMethod: { method: PaymentMethod; currency: string; totals: CashUpTotals }[];
  bySeller: {
    sellerUserId: string | null;
    sellerName: string | null;
    currency: string;
    totals: CashUpTotals;
  }[];
  /** One total per currency (amounts of different currencies are never added up). */
  totals: { currency: string; totals: CashUpTotals }[];
}

export const emptyCashUpTotals = (): CashUpTotals => ({
  orders: 0,
  tickets: 0,
  sales: 0,
  gross: 0,
  refunded: 0,
  net: 0,
  refundedOrders: 0,
  refundedOrdersGross: 0,
  refundsOpen: 0,
  cancelledOrders: 0,
  cancelledGross: 0,
});

/** Adds a line to the running totals (pure, covered by tests). */
export function addToTotals(totals: CashUpTotals, line: CashUpLine): CashUpTotals {
  const gross = totals.gross + line.gross;
  const refunded = totals.refunded + line.refunded;
  return {
    orders: totals.orders + line.orders,
    tickets: totals.tickets + line.tickets,
    sales: totals.sales + line.sales,
    gross,
    refunded,
    net: gross - refunded,
    refundedOrders: totals.refundedOrders + line.refundedOrders,
    refundedOrdersGross: totals.refundedOrdersGross + line.refundedOrdersGross,
    refundsOpen: totals.refundsOpen + line.refundsOpen,
    cancelledOrders: totals.cancelledOrders + line.cancelledOrders,
    cancelledGross: totals.cancelledGross + line.cancelledGross,
  };
}

/** Groups lines by `key`, summing totals; first-seen order is kept. */
export function summarise<K, L extends CashUpLine>(
  lines: readonly L[],
  key: (line: L) => K,
): Map<K, CashUpTotals> {
  const out = new Map<K, CashUpTotals>();
  for (const line of lines) {
    const k = key(line);
    out.set(k, addToTotals(out.get(k) ?? emptyCashUpTotals(), line));
  }
  return out;
}

/** Separator of composite group keys (seller / method / currency). */
const SEP = '\u0000';

export async function getCashUpReport(
  ctx: CoreContext,
  filter: CashUpFilter,
): Promise<CashUpReport> {
  if (!parseLocalDate(filter.from) || !parseLocalDate(filter.to) || filter.to < filter.from) {
    throw new DomainError('INVALID_RANGE', 'Invalid date range', 400);
  }
  const range = instantRange(filter.from, filter.to, filter.timeZone);
  // Which orders belong to the report at all (applies to sales and to refunds).
  const scope: SQL[] = [ne(orders.channel, 'ONLINE'), eq(orders.isTest, false)];
  if (filter.sellerUserId) scope.push(eq(orders.createdByUserId, filter.sellerUserId));
  if (filter.eventId) {
    scope.push(
      inArray(
        orders.id,
        ctx.db
          .select({ id: orderItems.orderId })
          .from(orderItems)
          .where(eq(orderItems.eventId, filter.eventId)),
      ),
    );
  }

  const sold = sql`${orders.status} IN ('PAID','PARTIALLY_REFUNDED')`;
  const received = sql`${orders.status} IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')`;
  const ticketCount = sql`(SELECT count(*) FROM ${orderItems} WHERE ${orderItems.orderId} = "orders"."id" AND ${orderItems.status} = 'CONFIRMED')`;
  const money = (expr: SQL) => sql<number>`coalesce(${expr}, 0)::bigint`.mapWith(Number);
  const orderRows = await ctx.db
    .select({
      sellerUserId: orders.createdByUserId,
      sellerName: adminUsers.displayName,
      method: orders.paymentMethod,
      currency: orders.currency,
      orders: sql<number>`count(*) FILTER (WHERE ${sold})::int`,
      tickets: sql<number>`coalesce(sum(${ticketCount}) FILTER (WHERE ${sold}), 0)::int`,
      sales: money(sql`sum(${orders.totalGross}) FILTER (WHERE ${sold})`),
      gross: money(sql`sum(${orders.amountPaid}) FILTER (WHERE ${received})`),
      refundedOrders: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'REFUNDED')::int`,
      refundedOrdersGross: money(
        sql`sum(${orders.totalGross}) FILTER (WHERE ${orders.status} = 'REFUNDED')`,
      ),
      cancelledOrders: sql<number>`count(*) FILTER (WHERE ${orders.status} IN ('CANCELLED','EXPIRED'))::int`,
      cancelledGross: money(
        sql`sum(${orders.totalGross}) FILTER (WHERE ${orders.status} IN ('CANCELLED','EXPIRED'))`,
      ),
    })
    .from(orders)
    .leftJoin(adminUsers, eq(adminUsers.id, orders.createdByUserId))
    .where(
      and(
        ...scope,
        gte(orders.createdAt, range.gte),
        lt(orders.createdAt, range.lt),
        inArray(orders.status, ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED', 'EXPIRED']),
      ),
    )
    .groupBy(orders.createdByUserId, adminUsers.displayName, orders.paymentMethod, orders.currency);

  // Refunds by their own dates: completed ones by `processed_at` (set when PayPal executed it or
  // an admin marked the manual transfer done), open ones by when they were requested.
  const gteAt = sql`${range.gte.toISOString()}::timestamptz`;
  const ltAt = sql`${range.lt.toISOString()}::timestamptz`;
  const done = sql`${refunds.status} = 'SUCCEEDED' AND ${refunds.processedAt} >= ${gteAt} AND ${refunds.processedAt} < ${ltAt}`;
  const open = sql`${refunds.status} IN ('PENDING','FAILED') AND ${refunds.createdAt} >= ${gteAt} AND ${refunds.createdAt} < ${ltAt}`;
  const refundRows = await ctx.db
    .select({
      sellerUserId: orders.createdByUserId,
      sellerName: adminUsers.displayName,
      method: refunds.method,
      currency: refunds.currency,
      refunded: money(sql`sum(${refunds.amount}) FILTER (WHERE ${done})`),
      refundsOpen: money(sql`sum(${refunds.amount}) FILTER (WHERE ${open})`),
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .leftJoin(adminUsers, eq(adminUsers.id, orders.createdByUserId))
    .where(and(...scope, sql`((${done}) OR (${open}))`))
    .groupBy(orders.createdByUserId, adminUsers.displayName, refunds.method, refunds.currency);

  const byKey = new Map<string, CashUpLine>();
  const lineFor = (r: {
    sellerUserId: string | null;
    sellerName: string | null;
    method: PaymentMethod;
    currency: string;
  }): CashUpLine => {
    const key = [r.sellerUserId ?? '', r.method, r.currency].join(SEP);
    let line = byKey.get(key);
    if (!line) {
      line = {
        sellerUserId: r.sellerUserId,
        sellerName: r.sellerName,
        method: r.method,
        currency: r.currency,
        orders: 0,
        tickets: 0,
        sales: 0,
        gross: 0,
        refunded: 0,
        refundedOrders: 0,
        refundedOrdersGross: 0,
        refundsOpen: 0,
        cancelledOrders: 0,
        cancelledGross: 0,
      };
      byKey.set(key, line);
    }
    return line;
  };
  for (const r of orderRows) {
    const line = lineFor(r);
    line.orders += r.orders;
    line.tickets += r.tickets;
    line.sales += r.sales;
    line.gross += r.gross;
    line.refundedOrders += r.refundedOrders;
    line.refundedOrdersGross += r.refundedOrdersGross;
    line.cancelledOrders += r.cancelledOrders;
    line.cancelledGross += r.cancelledGross;
  }
  for (const r of refundRows) {
    const line = lineFor(r);
    line.refunded += r.refunded;
    line.refundsOpen += r.refundsOpen;
  }
  const lines = [...byKey.values()].sort(
    (a, b) =>
      (a.sellerName ?? '￿').localeCompare(b.sellerName ?? '￿') ||
      a.method.localeCompare(b.method) ||
      a.currency.localeCompare(b.currency),
  );

  const byMethod = [...summarise(lines, (l) => [l.method, l.currency].join(SEP))].map(
    ([key, totals]) => {
      const [method, currency] = key.split(SEP) as [PaymentMethod, string];
      return { method, currency, totals };
    },
  );
  const sellerNames = new Map(lines.map((l) => [l.sellerUserId, l.sellerName]));
  const bySeller = [...summarise(lines, (l) => [l.sellerUserId ?? '', l.currency].join(SEP))].map(
    ([key, totals]) => {
      const [seller, currency] = key.split(SEP) as [string, string];
      const sellerUserId = seller === '' ? null : seller;
      return { sellerUserId, sellerName: sellerNames.get(sellerUserId) ?? null, currency, totals };
    },
  );
  const totals = [...summarise(lines, (l) => l.currency)].map(([currency, t]) => ({
    currency,
    totals: t,
  }));
  return { filter, lines, byMethod, bySeller, totals };
}

/** Admins who sold at the counter in the range (for the seller filter). */
export async function listCashUpSellers(ctx: CoreContext): Promise<{ id: string; name: string }[]> {
  const rows = await ctx.db
    .selectDistinct({ id: adminUsers.id, name: adminUsers.displayName })
    .from(orders)
    .innerJoin(adminUsers, eq(adminUsers.id, orders.createdByUserId))
    .where(ne(orders.channel, 'ONLINE'))
    .orderBy(asc(adminUsers.displayName));
  return rows;
}
