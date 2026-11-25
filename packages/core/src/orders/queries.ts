import {
  bankTransactionAllocations,
  adminUsers,
  bankAccounts,
  emailMessages,
  events,
  invoices,
  invoiceSupersessions,
  orderDiscounts,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  payments,
  tickets,
  venues,
} from '@tix/db';
import { localized } from '@tix/shared';
import type {
  CheckInState,
  OrderItemStatus,
  OrderStatus,
  PaymentMethod,
  SalesChannel,
  TicketStatus,
} from '@tix/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { instantRange, parseLocalDate } from '../accounting/dates';
import { parseStoredEmailRequest } from '../email/request';
import { placeOrderBy } from '../tickets/order';
import type { CoreContext } from '../context';
import { getSetting } from '../settings';
import {
  getAdjustmentPaymentOptions,
  findOpenAdjustment,
  type AdjustmentPaymentOptions,
} from './adjustments';

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
    /** Share of discount codes (already deducted from `priceGross`). */
    codeDiscountAmount: number;
    priceGross: number;
  }[];
}

/** Ticket summary for order pages (never the signed QR payload). */
export interface OrderTicketView {
  id: string;
  orderItemId: string;
  ticketCode: string;
  status: TicketStatus;
  checkInState: CheckInState;
  attendeeName: string | null;
  /** Set when the ticket was handed over to someone else (the buyer has no QR / download for it). */
  holderEmail: string | null;
}

/** Open additional payment (tariff change) as the customer sees it on the order page. */
export interface OrderAdjustmentView {
  id: string;
  status: 'PROPOSED' | 'CONFIRMED';
  /** Remaining cash to pay. */
  amount: number;
  /** Overpayment already received and credited against the difference. */
  creditApplied: number;
  currency: string;
  paymentReference: string;
  reason: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  items: {
    orderItemId: string;
    fromName: string;
    toName: string;
    fromPriceGross: number;
    toPriceGross: number;
  }[];
  /** Offered after the customer confirmed (null before). */
  payment: AdjustmentPaymentOptions | null;
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
  /** Discount codes used by the order (tickets + discounted fees), in the order applied. */
  discounts: { code: string; amount: number }[];
  taxes: { rateBasisPoints: number; net: number; tax: number }[];
  /** All tickets of the order, issued ones first (REPLACED history included). */
  tickets: OrderTicketView[];
  invoices: {
    id: string;
    type: string;
    invoiceNumber: string;
    issuedAt: string;
    /** Number of the invoice a credit note refers to. */
    correctsNumber: string | null;
    /**
     * Credit note that only corrects an invoice (additional payment, repair, reversed bank
     * allocation – a new invoice follows). No money is paid back; refund credit notes are false.
     */
    isCorrection: boolean;
  }[];
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
  /** Open additional payment (tariff change); the order itself stays PAID meanwhile. */
  adjustment: OrderAdjustmentView | null;
}

/** Full order with items grouped by event – for the customer order page and e-mails. */
export async function getOrderView(ctx: CoreContext, orderId: string): Promise<OrderView | null> {
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [itemRows, feeRows, invoiceRows, ticketRows, account, paypalSettings, discountRows] =
    await Promise.all([
      ctx.db
        .select({
          item: orderItems,
          event: {
            id: events.id,
            slug: events.slug,
            title: events.title,
            translations: events.translations,
            startsAt: events.startsAt,
            timeZone: events.timeZone,
          },
          venueName: venues.name,
          venueTranslations: venues.translations,
        })
        .from(orderItems)
        .innerJoin(events, eq(events.id, orderItems.eventId))
        .innerJoin(venues, eq(venues.id, events.venueId))
        .where(eq(orderItems.orderId, orderId))
        .orderBy(...placeOrderBy()),
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
          correctsInvoiceId: invoices.correctsInvoiceId,
        })
        .from(invoices)
        .where(eq(invoices.orderId, orderId))
        .orderBy(asc(invoices.issuedAt)),
      ctx.db
        .select({
          id: tickets.id,
          orderItemId: tickets.orderItemId,
          ticketCode: tickets.ticketCode,
          status: tickets.status,
          checkInState: tickets.checkInState,
          attendeeName: tickets.attendeeName,
          holderEmail: tickets.holderEmail,
        })
        .from(tickets)
        .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
        .innerJoin(events, eq(events.id, orderItems.eventId))
        .where(eq(tickets.orderId, orderId))
        .orderBy(...placeOrderBy(), asc(tickets.issuedAt), asc(tickets.ticketCode)),
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
      ctx.db
        .select({ code: orderDiscounts.code, amount: orderDiscounts.amount })
        .from(orderDiscounts)
        .where(eq(orderDiscounts.orderId, orderId))
        .orderBy(asc(orderDiscounts.position)),
    ]);

  const correctionIds = new Set(
    invoiceRows.length > 0
      ? (
          await ctx.db
            .select({ id: invoiceSupersessions.creditNoteId })
            .from(invoiceSupersessions)
            .where(
              inArray(
                invoiceSupersessions.creditNoteId,
                invoiceRows.map((i) => i.id),
              ),
            )
        ).map((r) => r.id)
      : [],
  );
  const byEvent = new Map<string, OrderEventView>();
  const defaultLocale = (await getSetting(ctx, 'general')).defaultLocale;
  for (const { item, event, venueName, venueTranslations } of itemRows) {
    let view = byEvent.get(event.id);
    if (!view) {
      view = {
        eventId: event.id,
        slug: event.slug,
        title: localized(event, 'title', order.locale, defaultLocale),
        startsAt: event.startsAt.toISOString(),
        timeZone: event.timeZone,
        venueName: localized(
          { translations: venueTranslations },
          'name',
          order.locale,
          defaultLocale,
          venueName,
        ),
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
      codeDiscountAmount: item.codeDiscountAmount,
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

  const openAdjustment = await findOpenAdjustment(ctx.db, orderId);
  const adjustment: OrderAdjustmentView | null = openAdjustment
    ? {
        id: openAdjustment.id,
        status: openAdjustment.status as 'PROPOSED' | 'CONFIRMED',
        amount: openAdjustment.amount,
        creditApplied: openAdjustment.creditApplied,
        currency: openAdjustment.currency,
        paymentReference: openAdjustment.paymentReference,
        reason: openAdjustment.reason,
        createdAt: openAdjustment.createdAt,
        confirmedAt: openAdjustment.confirmedAt,
        items: openAdjustment.items,
        payment:
          openAdjustment.status === 'CONFIRMED'
            ? await getAdjustmentPaymentOptions(ctx, openAdjustment)
            : null,
      }
    : null;
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
    discounts: discountRows,
    taxes: [...taxes.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([rateBasisPoints, v]) => ({ rateBasisPoints, ...v })),
    tickets: ticketRows,
    invoices: invoiceRows.map(({ correctsInvoiceId, ...i }) => ({
      ...i,
      issuedAt: i.issuedAt.toISOString(),
      correctsNumber: invoiceRows.find((o) => o.id === correctsInvoiceId)?.invoiceNumber ?? null,
      isCorrection: correctionIds.has(i.id),
    })),
    bankAccount: account[0] ?? null,
    paypal: {
      payable: expiresAt !== null && expiresAt.getTime() > Date.now(),
      expiresAt: expiresAt?.toISOString() ?? null,
    },
    outstanding: Math.max(0, order.totalGross - order.amountPaid),
    adjustment,
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
  channel?: SalesChannel;
  /** Unpaid Vorkasse orders past their auto-cancel date (kept reserved / partially paid). */
  overdueOnly?: boolean;
  /** Unpaid orders (awaiting payment or pending at the provider). */
  openOnly?: boolean;
  /** Test orders (super-admin purchases on draft events): shown by default; `only` / `hide` filter them. */
  tests?: 'only' | 'hide';
  /** Inclusive local dates (`YYYY-MM-DD`, shop time zone) of the order date. */
  from?: string;
  to?: string;
  /** Time zone for `from` / `to` (default UTC). */
  timeZone?: string;
  /** Sort column (default: newest first). */
  sort?: OrderSortKey;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export const ORDER_SORT_KEYS = [
  'date',
  'number',
  'customer',
  'method',
  'tickets',
  'total',
  'status',
] as const;
export type OrderSortKey = (typeof ORDER_SORT_KEYS)[number];

export interface OrderListRow {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  channel: SalesChannel;
  email: string | null;
  firstName: string;
  lastName: string;
  totalGross: number;
  amountPaid: number;
  currency: string;
  paymentReference: string | null;
  paymentDueAt: Date | null;
  autoCancelAt: Date | null;
  keepReserved: boolean;
  isTest: boolean;
  /** Cancelled test order with money, hidden from the default list. */
  testHidden: boolean;
  createdAt: Date;
  ticketCount: number;
}

/** WHERE clause of an order search (shared by the list and the CSV export). */
export function buildOrderConditions(ctx: CoreContext, search: OrderSearch): SQL | undefined {
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
  if (search.channel) conditions.push(eq(orders.channel, search.channel));
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
  if (search.tests === 'only') conditions.push(eq(orders.isTest, true));
  if (search.tests === 'hide') conditions.push(eq(orders.isTest, false));
  // Cancelled test orders that held real money are hidden from the plain list; the test filter
  // and any search (by number, e-mail, name, reference) still find them.
  if (search.tests !== 'only' && !q) conditions.push(isNull(orders.testHiddenAt));
  if (search.openOnly) conditions.push(inArray(orders.status, ['AWAITING_PAYMENT', 'PENDING']));
  if (search.overdueOnly) {
    conditions.push(eq(orders.status, 'AWAITING_PAYMENT'), sql`${orders.paymentDueAt} < now()`);
  }
  if (search.from && parseLocalDate(search.from)) {
    conditions.push(
      gte(orders.createdAt, instantRange(search.from, search.from, search.timeZone ?? 'UTC').gte),
    );
  }
  if (search.to && parseLocalDate(search.to)) {
    conditions.push(
      lt(orders.createdAt, instantRange(search.to, search.to, search.timeZone ?? 'UTC').lt),
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Drizzle renders columns unqualified in a single-table select, so the outer column is spelled out. */
export const ORDER_TICKET_COUNT = sql<number>`(SELECT count(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = "orders"."id")`;

const SORT_COLUMNS: Record<Exclude<OrderSortKey, 'tickets'>, SQL> = {
  date: sql`${orders.createdAt}`,
  number: sql`${orders.orderNumber}`,
  customer: sql`lower(${orders.lastName} || ' ' || ${orders.firstName})`,
  method: sql`${orders.paymentMethod}`,
  total: sql`${orders.totalGross}`,
  status: sql`${orders.status}`,
};

/** Stable ORDER BY: the chosen column, then newest first and id as tie-breakers. */
export function orderListOrderBy(search: Pick<OrderSearch, 'sort' | 'dir'>): SQL[] {
  const key = search.sort ?? 'date';
  const col = key === 'tickets' ? ORDER_TICKET_COUNT : SORT_COLUMNS[key];
  const primary = search.dir === 'asc' ? sql`${col} ASC` : sql`${col} DESC`;
  return key === 'date'
    ? [primary, sql`${orders.id} DESC`]
    : [primary, sql`${orders.createdAt} DESC`, sql`${orders.id} DESC`];
}

export async function searchOrders(
  ctx: CoreContext,
  search: OrderSearch,
): Promise<{ rows: OrderListRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(search.pageSize ?? 50, 1), 200);
  const page = Math.max(search.page ?? 1, 1);
  const where = buildOrderConditions(ctx, search);
  // Drizzle renders columns unqualified in a single-table select, so the outer column is spelled out.
  const ticketCount = ORDER_TICKET_COUNT;
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
        isTest: orders.isTest,
        testHidden: sql<boolean>`${orders.testHiddenAt} IS NOT NULL`,
        createdAt: orders.createdAt,
        ticketCount,
      })
      .from(orders)
      .where(where)
      .orderBy(...orderListOrderBy(search))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    ctx.db.select({ n: count() }).from(orders).where(where),
  ]);
  return { rows, total: totalRow?.n ?? 0, page, pageSize };
}

/** Keyset position of the order export (`created_at` as exact text: microseconds, not a JS Date). */
export interface OrderExportCursor {
  createdAt: string;
  id: string;
}

/**
 * One page of the CSV export: the search's filters, always newest first (`created_at DESC, id
 * DESC`), keyset-paged so orders created while the export runs never shift a page (no duplicated /
 * skipped rows as with OFFSET). Pass the returned `next` to get the following page.
 */
export async function searchOrdersForExport(
  ctx: CoreContext,
  search: OrderSearch,
  options: { after?: OrderExportCursor | null; limit?: number } = {},
): Promise<{ rows: OrderListRow[]; next: OrderExportCursor | null }> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const after = options.after;
  const where = and(
    buildOrderConditions(ctx, search),
    after
      ? sql`(${orders.createdAt}, ${orders.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
      : undefined,
  );
  const rows = await ctx.db
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
      isTest: orders.isTest,
      testHidden: sql<boolean>`${orders.testHiddenAt} IS NOT NULL`,
      createdAt: orders.createdAt,
      ticketCount: ORDER_TICKET_COUNT,
      cursorCreatedAt: sql<string>`${orders.createdAt}::text`,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit);
  const last = rows.at(-1);
  return {
    rows: rows.map(({ cursorCreatedAt: _cursor, ...row }) => row),
    next: last && rows.length === limit ? { createdAt: last.cursorCreatedAt, id: last.id } : null,
  };
}

/** One e-mail of the order (outbox row) for the admin timeline. */
export interface OrderEmailEntry {
  id: string;
  templateKey: string | null;
  toEmail: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  /** Names of the files actually sent, else the kinds queued (`invoice`, `tickets`). */
  attachments: { kind: 'invoice' | 'tickets' | 'file'; name: string | null }[];
}

export interface OrderAdminView extends OrderView {
  emails: OrderEmailEntry[];
  /** Admin who sold the order (box office / admin channel). */
  soldByName: string | null;
  history: (typeof orderHistory.$inferSelect & { actorName: string | null })[];
  payments: (typeof payments.$inferSelect)[];
  /** Bank allocations of the order's payments (reversed ones stay for the audit trail). */
  allocations: {
    id: string;
    paymentId: string | null;
    bankTransactionId: string;
    amount: number;
    reversedAt: Date | null;
    reversedByName: string | null;
    reversalReason: string | null;
  }[];
}

export async function getOrderAdminView(
  ctx: CoreContext,
  orderId: string,
): Promise<OrderAdminView | null> {
  const view = await getOrderView(ctx, orderId);
  if (!view) return null;
  const [history, paymentRows, allocations, [seller], emailRows] = await Promise.all([
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
    ctx.db
      .select({
        id: bankTransactionAllocations.id,
        paymentId: bankTransactionAllocations.paymentId,
        bankTransactionId: bankTransactionAllocations.bankTransactionId,
        amount: bankTransactionAllocations.amount,
        reversedAt: bankTransactionAllocations.reversedAt,
        reversedByName: adminUsers.displayName,
        reversalReason: bankTransactionAllocations.reversalReason,
      })
      .from(bankTransactionAllocations)
      .leftJoin(adminUsers, eq(adminUsers.id, bankTransactionAllocations.reversedByUserId))
      .where(eq(bankTransactionAllocations.orderId, orderId))
      .orderBy(asc(bankTransactionAllocations.createdAt)),
    view.order.createdByUserId
      ? ctx.db
          .select({ name: adminUsers.displayName })
          .from(adminUsers)
          .where(eq(adminUsers.id, view.order.createdByUserId))
      : Promise.resolve([]),
    ctx.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, orderId))
      .orderBy(desc(emailMessages.createdAt)),
  ]);
  return {
    ...view,
    emails: emailRows.map((m) => {
      const stored = parseStoredEmailRequest(m.attachments);
      return {
        id: m.id,
        templateKey: m.templateKey,
        toEmail: m.toEmail,
        subject: m.subject,
        status: m.status,
        attempts: m.attempts,
        lastError: m.lastError,
        createdAt: m.createdAt,
        sentAt: m.sentAt,
        attachments: stored.sentFiles
          ? stored.sentFiles.map((f) => ({ kind: 'file' as const, name: f.fileName }))
          : stored.attachments.map((a) =>
              a.type === 'object'
                ? { kind: 'file' as const, name: a.filename }
                : { kind: a.type, name: null },
            ),
      };
    }),
    history: history.map((h) => ({ ...h.entry, actorName: h.actorName })),
    payments: paymentRows,
    allocations,
    soldByName: seller?.name ?? null,
  };
}
