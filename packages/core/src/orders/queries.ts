import {
  adminUsers,
  bankAccounts,
  events,
  invoices,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  payments,
  venues,
} from '@tix/db';
import type { OrderItemStatus, OrderStatus, PaymentMethod } from '@tix/shared';
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { getSetting } from '../settings';

type OrderRecord = typeof orders.$inferSelect;

export interface OrderEventView {
  eventId: string;
  slug: string;
  title: string;
  startsAt: string;
  timeZone: string;
  venueName: string;
  items: {
    id: string;
    kind: 'SEAT' | 'GENERAL_ADMISSION';
    status: OrderItemStatus;
    sectionLabel: string;
    rowLabel: string | null;
    seatLabel: string | null;
    categoryName: string;
    ticketTypeName: string;
    unitPriceGross: number;
    discountAmount: number;
    priceGross: number;
  }[];
}

export interface OrderView {
  order: OrderRecord;
  events: OrderEventView[];
  fees: {
    id: string;
    eventId: string | null;
    name: string;
    quantity: number;
    totalGross: number;
  }[];
  taxes: { rateBasisPoints: number; net: number; tax: number }[];
  invoices: { id: string; type: string; invoiceNumber: string; issuedAt: string }[];
  /** Receiving account for Vorkasse (null when none is configured). */
  bankAccount: {
    accountHolder: string;
    iban: string;
    bic: string | null;
    bankName: string | null;
  } | null;
  /** Unpaid PayPal order still within the approval window. */
  paypal: { payable: boolean; expiresAt: string | null };
  outstanding: number;
}

/** Full order with items grouped by event – for the customer order page and e-mails. */
export async function getOrderView(ctx: CoreContext, orderId: string): Promise<OrderView | null> {
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [itemRows, feeRows, invoiceRows, account, paypalSettings] = await Promise.all([
    ctx.db
      .select({
        item: orderItems,
        event: {
          id: events.id,
          slug: events.slug,
          title: events.title,
          startsAt: events.startsAt,
          timeZone: events.timeZone,
        },
        venueName: venues.name,
      })
      .from(orderItems)
      .innerJoin(events, eq(events.id, orderItems.eventId))
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(eq(orderItems.orderId, orderId))
      .orderBy(
        asc(events.startsAt),
        asc(orderItems.sectionLabel),
        asc(orderItems.rowLabel),
        asc(orderItems.seatLabel),
      ),
    ctx.db
      .select()
      .from(orderFees)
      .where(eq(orderFees.orderId, orderId))
      .orderBy(asc(orderFees.createdAt)),
    ctx.db
      .select({
        id: invoices.id,
        type: invoices.type,
        invoiceNumber: invoices.invoiceNumber,
        issuedAt: invoices.issuedAt,
      })
      .from(invoices)
      .where(eq(invoices.orderId, orderId))
      .orderBy(asc(invoices.issuedAt)),
    order.paymentMethod === 'BANK_TRANSFER'
      ? ctx.db
          .select({
            accountHolder: bankAccounts.accountHolder,
            iban: bankAccounts.iban,
            bic: bankAccounts.bic,
            bankName: bankAccounts.bankName,
          })
          .from(bankAccounts)
          .where(
            and(eq(bankAccounts.isDefaultForBankTransfer, true), eq(bankAccounts.isActive, true)),
          )
          .limit(1)
      : Promise.resolve([]),
    getSetting(ctx, 'paypal'),
  ]);

  const byEvent = new Map<string, OrderEventView>();
  for (const { item, event, venueName } of itemRows) {
    let view = byEvent.get(event.id);
    if (!view) {
      view = {
        eventId: event.id,
        slug: event.slug,
        title: event.title,
        startsAt: event.startsAt.toISOString(),
        timeZone: event.timeZone,
        venueName,
        items: [],
      };
      byEvent.set(event.id, view);
    }
    view.items.push({
      id: item.id,
      kind: item.kind,
      status: item.status,
      sectionLabel: item.sectionLabel,
      rowLabel: item.rowLabel,
      seatLabel: item.seatLabel,
      categoryName: item.categoryName,
      ticketTypeName: item.ticketTypeName,
      unitPriceGross: item.unitPriceGross,
      discountAmount: item.discountAmount,
      priceGross: item.priceGross,
    });
  }

  const taxes = new Map<number, { net: number; tax: number }>();
  const addTax = (rate: number, net: number, tax: number) => {
    const entry = taxes.get(rate) ?? { net: 0, tax: 0 };
    entry.net += net;
    entry.tax += tax;
    taxes.set(rate, entry);
  };
  for (const { item } of itemRows) addTax(item.taxRateBasisPoints, item.priceNet, item.taxAmount);
  for (const fee of feeRows) addTax(fee.taxRateBasisPoints, fee.totalNet, fee.totalTax);

  const expiresAt =
    order.status === 'PENDING' && order.paymentMethod === 'PAYPAL'
      ? new Date(order.createdAt.getTime() + paypalSettings.approvalTimeoutSeconds * 1000)
      : null;
  return {
    order,
    events: [...byEvent.values()],
    fees: feeRows.map((f) => ({
      id: f.id,
      eventId: f.eventId,
      name: f.name,
      quantity: f.quantity,
      totalGross: f.totalGross,
    })),
    taxes: [...taxes.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([rateBasisPoints, v]) => ({ rateBasisPoints, ...v })),
    invoices: invoiceRows.map((i) => ({ ...i, issuedAt: i.issuedAt.toISOString() })),
    bankAccount: account[0] ?? null,
    paypal: {
      payable: expiresAt !== null && expiresAt.getTime() > Date.now(),
      expiresAt: expiresAt?.toISOString() ?? null,
    },
    outstanding: Math.max(0, order.totalGross - order.amountPaid),
  };
}

export async function findOrderIdByNumber(
  ctx: CoreContext,
  orderNumber: string,
): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber));
  return row?.id ?? null;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export interface OrderSearch {
  q?: string;
  status?: OrderStatus;
  method?: PaymentMethod;
  eventId?: string;
  /** Unpaid Vorkasse orders past their auto-cancel date (kept reserved / partially paid). */
  overdueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface OrderListRow {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  channel: string;
  email: string;
  firstName: string;
  lastName: string;
  totalGross: number;
  amountPaid: number;
  currency: string;
  paymentReference: string | null;
  paymentDueAt: Date | null;
  autoCancelAt: Date | null;
  keepReserved: boolean;
  createdAt: Date;
  ticketCount: number;
}

export async function searchOrders(
  ctx: CoreContext,
  search: OrderSearch,
): Promise<{ rows: OrderListRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(search.pageSize ?? 50, 1), 200);
  const page = Math.max(search.page ?? 1, 1);
  const conditions: SQL[] = [];
  const q = search.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    // Payment references are matched tolerant of separators / case.
    const compact = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    conditions.push(
      or(
        ilike(orders.orderNumber, like),
        ilike(orders.email, like),
        ilike(sql`${orders.firstName} || ' ' || ${orders.lastName}`, like),
        ...(compact.length >= 4
          ? [sql`replace(${orders.paymentReference}, '-', '') LIKE ${`%${compact}%`}`]
          : []),
      )!,
    );
  }
  if (search.status) conditions.push(eq(orders.status, search.status));
  if (search.method) conditions.push(eq(orders.paymentMethod, search.method));
  if (search.eventId) {
    conditions.push(
      inArray(
        orders.id,
        ctx.db
          .select({ id: orderItems.orderId })
          .from(orderItems)
          .where(eq(orderItems.eventId, search.eventId)),
      ),
    );
  }
  if (search.overdueOnly) {
    conditions.push(eq(orders.status, 'AWAITING_PAYMENT'), sql`${orders.paymentDueAt} < now()`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const ticketCount = sql<number>`(SELECT count(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id})`;
  const [rows, [totalRow]] = await Promise.all([
    ctx.db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        channel: orders.channel,
        email: orders.email,
        firstName: orders.firstName,
        lastName: orders.lastName,
        totalGross: orders.totalGross,
        amountPaid: orders.amountPaid,
        currency: orders.currency,
        paymentReference: orders.paymentReference,
        paymentDueAt: orders.paymentDueAt,
        autoCancelAt: orders.autoCancelAt,
        keepReserved: orders.keepReserved,
        createdAt: orders.createdAt,
        ticketCount,
      })
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    ctx.db.select({ n: count() }).from(orders).where(where),
  ]);
  return { rows, total: totalRow?.n ?? 0, page, pageSize };
}

export interface OrderAdminView extends OrderView {
  history: (typeof orderHistory.$inferSelect & { actorName: string | null })[];
  payments: (typeof payments.$inferSelect)[];
}

export async function getOrderAdminView(
  ctx: CoreContext,
  orderId: string,
): Promise<OrderAdminView | null> {
  const view = await getOrderView(ctx, orderId);
  if (!view) return null;
  const [history, paymentRows] = await Promise.all([
    ctx.db
      .select({ entry: orderHistory, actorName: adminUsers.displayName })
      .from(orderHistory)
      .leftJoin(adminUsers, eq(adminUsers.id, orderHistory.actorUserId))
      .where(eq(orderHistory.orderId, orderId))
      .orderBy(desc(orderHistory.createdAt)),
    ctx.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(desc(payments.createdAt)),
  ]);
  return {
    ...view,
    history: history.map((h) => ({ ...h.entry, actorName: h.actorName })),
    payments: paymentRows,
  };
}
