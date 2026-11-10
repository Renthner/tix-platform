import { randomInt } from 'node:crypto';
import {
  bankAccounts,
  emailMessages,
  events,
  isUniqueViolation,
  orderAdjustments,
  orderHistory,
  orderItems,
  orders,
  payments,
  tickets,
  withTransaction,
  type AdjustmentItemSnapshot,
  type Transaction,
} from '@tix/db';
import { buildPaymentReference, splitGross, type PaymentMethod } from '@tix/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { allowedTypesFor, seatIndex } from '../cart';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage, type EmailAttachment } from '../email';
import { getEventCached } from '../events';
import { enqueueInvoiceRender, findActiveInvoice, issueInvoiceInTransaction } from '../invoices';
import { getSeatMapForChannel } from '../seatmaps/public';
import { getSetting } from '../settings';
import { lockOrderTickets, reissueTicketInTransaction } from '../tickets/issue';
import {
  OPEN_ADJUSTMENT_STATUSES,
  cancelOpenAdjustmentInTransaction,
  queueAdjustmentCancelledMail,
  type AdjustmentRow,
} from './adjustment-state';
import { orderCredit, orderNetPaid } from './credit';
import type { OrderActor } from './fulfillment';
import { paymentAvailabilityForEvents } from './pricing';
import { issueFullCreditNote } from './refunds';

export {
  OPEN_ADJUSTMENT_STATUSES,
  findOpenAdjustment,
  openAdjustmentItemIds,
  ticketHasOpenAdjustment,
  type AdjustmentRow,
} from './adjustment-state';

/**
 * Additional payment for a PAID order: an admin changes the tariff of tickets to a more
 * expensive one (reduced → normal). See `order_adjustments`.
 *
 *  - `proposeTariffChange` → PROPOSED, e-mail ADDITIONAL_PAYMENT_REQUEST (link to the order page).
 *    Order, items, tickets and invoice are NOT touched; the ticket stays VALID.
 *  - `confirmAdjustment` (customer, "Zahlungspflichtig bestätigen") → CONFIRMED; then PayPal or
 *    bank transfer (own payment reference) are offered.
 *  - `completeAdjustment` (payment arrived) → one transaction: payment row, items / totals /
 *    amount_paid updated, tickets re-issued (new QR, old REPLACED), the invoice corrected with a
 *    full credit note + a new invoice over the updated order, confirmation e-mail queued.
 *  - `cancelAdjustment` (admin) → CANCELLED; nothing else to undo ("reset the tariff").
 *
 * Fees are not recalculated: only the ticket prices change (a percentage fee stays as sold).
 * Lock order everywhere: ticket advisory lock → order row → adjustment row.
 */

const MAX_CHANGES = 100;
const REFERENCE_DIGITS = 6;
const REFERENCE_ATTEMPTS = 8;

export const tariffChangeSchema = z
  .array(z.object({ orderItemId: z.uuid(), newTicketTypeId: z.uuid() }))
  .min(1)
  .max(MAX_CHANGES);

export interface ProposeTariffChangeParams {
  orderId: string;
  changes: { orderItemId: string; newTicketTypeId: string }[];
  reason?: string | null;
  /** Send the ADDITIONAL_PAYMENT_REQUEST e-mail (needs an e-mail address on the order). */
  notify: boolean;
  userId: string;
  /** Optimistic concurrency guard against a stale admin page. */
  expectedVersion?: number;
  /**
   * The caller may use customer money (credit) – FINANCE only. With an overpayment on the order
   * and no permission the proposal is refused (the credit is never silently ignored).
   */
  canUseCredit?: boolean;
}

export interface ProposeTariffChangeResult {
  adjustmentId: string;
  /** Cash the customer still has to pay (0 when an overpayment covers the whole difference). */
  amount: number;
  /** Price difference of the changed tickets (= amount + creditApplied). */
  difference: number;
  /** Overpayment of the order credited against the difference. */
  creditApplied: number;
  /** The overpayment covered everything: the tariff change was applied right away. */
  settledByCredit: boolean;
  currency: string;
  paymentReference: string;
  emailQueued: boolean;
  items: AdjustmentItemSnapshot[];
}

async function referenceTaken(tx: Transaction, reference: string): Promise<boolean> {
  const [inOrders] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.paymentReference, reference));
  if (inOrders) return true;
  const [inAdjustments] = await tx
    .select({ id: orderAdjustments.id })
    .from(orderAdjustments)
    .where(eq(orderAdjustments.paymentReference, reference));
  return Boolean(inAdjustments);
}

/** New Verwendungszweck (`PREFIX-YYYY-NNNNNN-C`) that is unique across orders and adjustments. */
async function newAdjustmentReference(
  ctx: CoreContext,
  tx: Transaction,
  now: Date,
): Promise<string> {
  const [bank, general] = await Promise.all([
    getSetting(ctx, 'bankTransfer'),
    getSetting(ctx, 'general'),
  ]);
  const year = Number(
    new Intl.DateTimeFormat('en', { timeZone: general.defaultTimeZone, year: 'numeric' }).format(
      now,
    ),
  );
  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    const reference = buildPaymentReference(
      bank.paymentReferencePrefix,
      year,
      String(randomInt(10 ** (REFERENCE_DIGITS - 1), 10 ** REFERENCE_DIGITS)),
    );
    if (!(await referenceTaken(tx, reference))) return reference;
  }
  throw new DomainError('REFERENCE_UNAVAILABLE', 'Could not allocate a payment reference', 503);
}

export async function proposeTariffChange(
  ctx: CoreContext,
  rawParams: ProposeTariffChangeParams,
  attemptNo = 1,
): Promise<ProposeTariffChangeResult> {
  const params = { ...rawParams, changes: tariffChangeSchema.parse(rawParams.changes) };
  const { orderId } = params;
  if (new Set(params.changes.map((c) => c.orderItemId)).size !== params.changes.length) {
    throw new DomainError('INVALID_REQUEST', 'A ticket was selected twice', 422);
  }

  // ── Pre-read (no locks): prices from the current matrix of the order's channel ──
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  assertAdjustable(order);
  const items = await ctx.db
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, orderId),
        inArray(
          orderItems.id,
          params.changes.map((c) => c.orderItemId),
        ),
      ),
    );
  const itemById = new Map(items.map((i) => [i.id, i]));
  const maps = new Map<string, Awaited<ReturnType<typeof getSeatMapForChannel>>>();
  for (const eventId of [...new Set(items.map((i) => i.eventId))].sort()) {
    const event = await getEventCached(ctx, eventId);
    maps.set(eventId, await getSeatMapForChannel(ctx, event, order.channel));
  }
  const snapshots: AdjustmentItemSnapshot[] = params.changes.map((change) => {
    const item = itemById.get(change.orderItemId);
    if (!item) throw new DomainError('ORDER_ITEM_NOT_FOUND', 'Order item not found', 404);
    if (item.status !== 'CONFIRMED') {
      throw new DomainError('ITEM_NOT_ACTIVE', 'Only active tickets can be changed', 409);
    }
    if (item.ticketTypeId === change.newTicketTypeId) {
      throw new DomainError('INVALID_REQUEST', 'The ticket already has this tariff', 422);
    }
    const map = maps.get(item.eventId)!;
    const seat = item.seatId ? seatIndex(map).get(item.seatId) : undefined;
    const target = allowedTypesFor(map, item.priceCategoryId, seat ? seat.f : null).find(
      (t) => t.id === change.newTicketTypeId,
    );
    const toPrice = target?.prices[item.priceCategoryId];
    if (!target || toPrice === undefined) {
      throw new DomainError(
        'TARIFF_NOT_ALLOWED',
        'This tariff is not offered for this ticket',
        422,
        {
          orderItemId: item.id,
        },
      );
    }
    if (toPrice <= item.priceGross) {
      throw new DomainError(
        'ADJUSTMENT_NOT_HIGHER',
        'The new tariff must cost more than the price paid',
        422,
        { orderItemId: item.id, paid: item.priceGross, price: toPrice },
      );
    }
    return {
      orderItemId: item.id,
      fromPriceCategoryId: item.priceCategoryId,
      fromTicketTypeId: item.ticketTypeId,
      toTicketTypeId: target.id,
      fromName: item.ticketTypeName,
      toName: target.name,
      fromPriceGross: item.priceGross,
      toPriceGross: toPrice,
    };
  });
  const difference = snapshots.reduce((sum, s) => sum + (s.toPriceGross - s.fromPriceGross), 0);

  // ── Transaction ────────────────────────────────────────────────────────────
  let outcome: {
    adjustmentId: string;
    reference: string;
    messageId: string | null;
    amount: number;
    creditApplied: number;
    renders: string[];
  };
  try {
    outcome = await withTransaction(ctx.db, async (tx) => {
      await lockOrderTickets(tx, orderId);
      const [locked] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (!locked) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
      assertAdjustable(locked);
      if (params.expectedVersion !== undefined && params.expectedVersion !== locked.version) {
        throw new DomainError('ORDER_CHANGED', 'The order was changed in the meantime', 409);
      }
      const [open] = await tx
        .select({ id: orderAdjustments.id })
        .from(orderAdjustments)
        .where(
          and(
            eq(orderAdjustments.orderId, orderId),
            inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
          ),
        );
      if (open) {
        throw new DomainError(
          'ADJUSTMENT_ALREADY_OPEN',
          'This order already has an open additional payment',
          409,
        );
      }
      const lockedItems = await lockAdjustmentItems(tx, snapshots);
      if (!lockedItems.ok) {
        throw new DomainError('ORDER_CHANGED', 'The order was changed in the meantime', 409);
      }
      // An overpayment of the order is credited against the difference (money already received
      // must not be requested a second time).
      const { credit } = await orderCredit(tx, locked);
      if (credit > 0 && !params.canUseCredit) {
        throw new DomainError(
          'CREDIT_REQUIRES_FINANCE',
          'The order has an overpayment; only finance can credit it against a tariff change',
          403,
          { credit },
        );
      }
      const creditApplied = Math.min(credit, difference);
      const amount = difference - creditApplied;
      const reference = await newAdjustmentReference(ctx, tx, new Date());
      const [adjustment] = await tx
        .insert(orderAdjustments)
        .values({
          orderId,
          status: 'PROPOSED',
          kind: 'TARIFF_UPGRADE',
          amount,
          creditApplied,
          currency: locked.currency,
          paymentReference: reference,
          items: snapshots,
          reason: params.reason?.trim() || null,
          createdByUserId: params.userId,
        })
        .returning();
      await tx
        .update(orders)
        .set({ version: sql`${orders.version} + 1` })
        .where(eq(orders.id, orderId));
      await tx.insert(orderHistory).values({
        orderId,
        type: 'adjustment_proposed',
        actorType: 'ADMIN',
        actorUserId: params.userId,
        data: {
          adjustmentId: adjustment!.id,
          amount,
          difference,
          creditApplied,
          reference,
          items: snapshots,
          reason: params.reason?.trim() || null,
          notify: params.notify && Boolean(locked.email),
        },
      });
      if (amount === 0) {
        // The overpayment covers the whole difference: nothing to request, apply right away.
        const applied = await applyAdjustmentInTransaction(ctx, tx, {
          order: locked,
          adjustment: adjustment!,
          itemById: lockedItems.itemById,
          paymentId: null,
          method: null,
          cash: 0,
          creditUsed: creditApplied,
          previouslyPaid: await orderNetPaid(tx, orderId),
          capturedAt: new Date(),
          actor: { type: 'ADMIN', userId: params.userId },
          notify: params.notify,
          invoicingEnabled: (await getSetting(ctx, 'invoicing')).issueInvoices,
        });
        return {
          adjustmentId: adjustment!.id,
          reference,
          messageId: applied.messageId,
          amount,
          creditApplied,
          renders: applied.renders,
        };
      }
      const messageId =
        params.notify && locked.email
          ? await createEmailMessage(ctx, tx, {
              key: 'ADDITIONAL_PAYMENT_REQUEST',
              orderId,
              variables: { adjustmentId: adjustment!.id },
            })
          : null;
      return {
        adjustmentId: adjustment!.id,
        reference,
        messageId,
        amount,
        creditApplied,
        renders: [] as string[],
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'order_adjustments_payment_reference_uq') && attemptNo < 4) {
      return proposeTariffChange(ctx, rawParams, attemptNo + 1);
    }
    if (isUniqueViolation(err, 'order_adjustments_one_open_uq')) {
      throw new DomainError(
        'ADJUSTMENT_ALREADY_OPEN',
        'This order already has an open additional payment',
        409,
      );
    }
    throw err;
  }
  await afterAdjustmentCommit(ctx, outcome);
  return {
    adjustmentId: outcome.adjustmentId,
    amount: outcome.amount,
    difference,
    creditApplied: outcome.creditApplied,
    settledByCredit: outcome.amount === 0,
    currency: order.currency,
    paymentReference: outcome.reference,
    emailQueued: outcome.messageId !== null,
    items: snapshots,
  };
}

function assertAdjustable(order: { status: string; paymentMethod: string }): void {
  if (order.status === 'PARTIALLY_REFUNDED') {
    throw new DomainError(
      'ADJUSTMENT_NOT_POSSIBLE_REFUNDED',
      'The tariff of a partially refunded order cannot be changed',
      409,
    );
  }
  if (order.status !== 'PAID') {
    throw new DomainError(
      'ADJUSTMENT_NOT_POSSIBLE',
      'Only paid orders can get a tariff change',
      409,
      {
        status: order.status,
      },
    );
  }
  if (order.paymentMethod === 'COMPLIMENTARY') {
    throw new DomainError(
      'ADJUSTMENT_NOT_POSSIBLE_COMPLIMENTARY',
      'Complimentary orders cannot get an additional payment',
      409,
    );
  }
}

// ─── Customer confirmation ──────────────────────────────────────────────────

/**
 * "Zahlungspflichtig bestätigen": PROPOSED → CONFIRMED. Idempotent for an already confirmed
 * adjustment; a paid / cancelled one is rejected.
 */
export async function confirmAdjustment(
  ctx: CoreContext,
  params: { adjustmentId: string; orderId: string },
): Promise<{ confirmed: boolean }> {
  return withTransaction(ctx.db, async (tx) => {
    const [updated] = await tx
      .update(orderAdjustments)
      .set({ status: 'CONFIRMED', confirmedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(orderAdjustments.id, params.adjustmentId),
          eq(orderAdjustments.orderId, params.orderId),
          eq(orderAdjustments.status, 'PROPOSED'),
        ),
      )
      .returning({ id: orderAdjustments.id, amount: orderAdjustments.amount });
    if (updated) {
      await tx.insert(orderHistory).values({
        orderId: params.orderId,
        type: 'adjustment_confirmed',
        actorType: 'CUSTOMER',
        data: { adjustmentId: updated.id, amount: updated.amount },
      });
      return { confirmed: true };
    }
    const [row] = await tx
      .select({ status: orderAdjustments.status })
      .from(orderAdjustments)
      .where(
        and(
          eq(orderAdjustments.id, params.adjustmentId),
          eq(orderAdjustments.orderId, params.orderId),
        ),
      );
    if (!row) throw new DomainError('ADJUSTMENT_NOT_FOUND', 'Additional payment not found', 404);
    if (row.status === 'CONFIRMED') return { confirmed: false };
    throw new DomainError(
      'ADJUSTMENT_NOT_OPEN',
      'This additional payment is not open any more',
      409,
      {
        status: row.status,
      },
    );
  });
}

// ─── Admin: reset the tariff = cancel the adjustment ────────────────────────

export async function cancelAdjustment(
  ctx: CoreContext,
  params: { adjustmentId: string; userId: string; reason?: string | null },
): Promise<void> {
  const [adjustment] = await ctx.db
    .select({ orderId: orderAdjustments.orderId })
    .from(orderAdjustments)
    .where(eq(orderAdjustments.id, params.adjustmentId));
  if (!adjustment)
    throw new DomainError('ADJUSTMENT_NOT_FOUND', 'Additional payment not found', 404);
  const messageId = await withTransaction(ctx.db, async (tx) => {
    await lockOrderTickets(tx, adjustment.orderId);
    await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, adjustment.orderId))
      .for('update');
    const [row] = await tx
      .select()
      .from(orderAdjustments)
      .where(eq(orderAdjustments.id, params.adjustmentId))
      .for('update');
    if (!row || !(OPEN_ADJUSTMENT_STATUSES as readonly string[]).includes(row.status)) {
      throw new DomainError(
        'ADJUSTMENT_NOT_OPEN',
        'This additional payment is not open any more',
        409,
        { status: row?.status ?? null },
      );
    }
    await cancelOpenAdjustmentInTransaction(tx, adjustment.orderId, {
      actor: { type: 'ADMIN', userId: params.userId },
      reason: params.reason,
    });
    return queueAdjustmentCancelledMail(ctx, tx, row);
  });
  if (messageId) {
    await dispatchEmailMessage(ctx, messageId).catch((err: unknown) =>
      console.error('[adjustments] cancellation mail stored but not queued (outbox retries)', err),
    );
  }
}

// ─── Payment completion ─────────────────────────────────────────────────────

export interface AdjustmentPaymentReceipt {
  adjustmentId: string;
  /** Captured amount in cents; must equal the adjustment amount. */
  amount: number;
  currency: string;
  method: PaymentMethod;
  capturedAt?: Date;
  providerOrderId?: string | null;
  providerCaptureId?: string | null;
  bankTransactionId?: string | null;
  receivedByUserId?: string | null;
  providerResponse?: unknown;
  actor: OrderActor;
}

export type NotPayableReason =
  | 'ADJUSTMENT_CANCELLED'
  | 'ADJUSTMENT_PAID'
  | 'ORDER_NOT_PAID'
  | 'ITEMS_CHANGED'
  | 'AMOUNT_MISMATCH'
  /** The overpayment credited at proposal time is gone (refunded): the amount to pay changed. */
  | 'CREDIT_CHANGED'
  | 'CURRENCY_MISMATCH';

export type CompleteAdjustmentResult =
  | { status: 'PAID'; adjustmentId: string; orderId: string; paymentId: string }
  /** The same capture / bank transaction was booked before (idempotent no-op). */
  | { status: 'DUPLICATE'; adjustmentId: string; orderId: string; paymentId: string }
  /** Nothing was booked – the money needs a human (Klärfall) or an automatic refund. */
  | {
      status: 'NOT_PAYABLE';
      adjustmentId: string;
      orderId: string;
      reason: NotPayableReason;
      expectedAmount: number;
    };

interface Documents {
  creditNote: { id: string; number: string } | null;
  /** Number of the invoice the credit note cancelled. */
  oldInvoiceNumber?: string | null;
  invoice: { invoiceId: string; invoiceNumber: string; created: boolean } | null;
  oldInvoiceIssued: string | null;
  problem: string | null;
}

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

/**
 * Locks the order items of an adjustment and checks they are still as proposed (same tariff,
 * price and category). `ok = false` means the adjustment can never be applied.
 */
async function lockAdjustmentItems(
  tx: Transaction,
  changes: AdjustmentItemSnapshot[],
): Promise<{ ok: boolean; itemById: Map<string, OrderItemRow> }> {
  const itemRows = await tx
    .select()
    .from(orderItems)
    .where(
      inArray(
        orderItems.id,
        changes.map((i) => i.orderItemId),
      ),
    )
    .for('update');
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  const ok = changes.every((change) => {
    const item = itemById.get(change.orderItemId);
    return (
      item !== undefined &&
      item.status === 'CONFIRMED' &&
      item.ticketTypeId === change.fromTicketTypeId &&
      item.priceGross === change.fromPriceGross &&
      item.priceCategoryId === change.fromPriceCategoryId
    );
  });
  return { ok, itemById };
}

interface ApplyAdjustmentParams {
  /** Locked order row (before the change). */
  order: OrderRow;
  /** Locked adjustment row (still open or freshly inserted). */
  adjustment: AdjustmentRow;
  /** Locked, verified items (see `lockAdjustmentItems`). */
  itemById: Map<string, OrderItemRow>;
  /** The booked payment row; null when an overpayment settled the adjustment. */
  paymentId: string | null;
  method: PaymentMethod | null;
  /** Money received for this adjustment (0 when settled by credit). */
  cash: number;
  /** Overpayment credited against the difference. */
  creditUsed: number;
  /** Net money received before this adjustment (incl. the overpayment that is credited). */
  previouslyPaid: number;
  capturedAt: Date;
  actor: OrderActor;
  /** Send the customer e-mail (always for a paid adjustment; optional when settled by credit). */
  notify: boolean;
  invoicingEnabled: boolean;
}

/**
 * Applies a paid / credit-settled adjustment inside the caller's transaction (ticket lock, order
 * row and adjustment row are locked by the caller): items, totals, `amount_paid` (cash only),
 * invoice correction (full credit note + new invoice, in a savepoint so a document problem never
 * undoes the payment), re-issued tickets, history and the customer e-mail outbox row.
 */
async function applyAdjustmentInTransaction(
  ctx: CoreContext,
  tx: Transaction,
  p: ApplyAdjustmentParams,
): Promise<{ renders: string[]; messageId: string | null }> {
  const { order, adjustment, itemById } = p;
  const orderId = order.id;
  const now = new Date();
  const difference = adjustment.items.reduce((s, i) => s + (i.toPriceGross - i.fromPriceGross), 0);

  const changed = adjustment.items.map((change) => {
    const item = itemById.get(change.orderItemId)!;
    const unit = Math.max(item.unitPriceGross, change.toPriceGross);
    const split = splitGross(change.toPriceGross, item.taxRateBasisPoints);
    return {
      item,
      change,
      unitPriceGross: unit,
      discountAmount: unit - change.toPriceGross,
      priceNet: split.net,
      taxAmount: split.tax,
    };
  });
  const applyChanges = async (db: Transaction) => {
    for (const c of changed) {
      await db
        .update(orderItems)
        .set({
          ticketTypeId: c.change.toTicketTypeId,
          ticketTypeName: c.change.toName,
          unitPriceGross: c.unitPriceGross,
          discountAmount: c.discountAmount,
          priceGross: c.change.toPriceGross,
          priceNet: c.priceNet,
          taxAmount: c.taxAmount,
        })
        .where(eq(orderItems.id, c.item.id));
    }
    const sum = (pick: (c: (typeof changed)[number]) => number) =>
      changed.reduce((s, c) => s + pick(c), 0);
    await db
      .update(orders)
      .set({
        subtotalGross: sql`${orders.subtotalGross} + ${sum((c) => c.unitPriceGross - c.item.unitPriceGross)}`,
        discountTotal: sql`${orders.discountTotal} + ${sum((c) => c.discountAmount - c.item.discountAmount)}`,
        // The total grows by the full price difference; `amount_paid` only by the cash received
        // (a credited overpayment is already part of it).
        totalGross: sql`${orders.totalGross} + ${difference}`,
        totalNet: sql`${orders.totalNet} + ${sum((c) => c.priceNet - c.item.priceNet)}`,
        totalTax: sql`${orders.totalTax} + ${sum((c) => c.taxAmount - c.item.taxAmount)}`,
        amountPaid: sql`${orders.amountPaid} + ${p.cash}`,
        version: sql`${orders.version} + 1`,
        updatedAt: now,
      })
      .where(eq(orders.id, orderId));
  };

  // The adjustment is PAID before the invoice is issued: the invoice note reads the credit from
  // it. `updated_at` = `now` precedes the invoice's `issued_at` (see `staleInvoiceExists`).
  await tx
    .update(orderAdjustments)
    .set({
      status: 'PAID',
      paidAt: p.capturedAt,
      confirmedAt: adjustment.confirmedAt ?? now,
      creditApplied: p.creditUsed,
      updatedAt: now,
    })
    .where(eq(orderAdjustments.id, adjustment.id));

  // ── Invoice correction: full credit note of the old invoice + new invoice ──
  let docs: Documents = {
    creditNote: null,
    invoice: null,
    oldInvoiceIssued: null,
    problem: null,
  };
  let applied = false;
  if (p.invoicingEnabled) {
    try {
      docs = await tx.transaction(async (sp) => {
        // An invoice in force is negated completely and replaced; when the (asynchronous)
        // invoice job has not issued one yet, a single invoice over the new state is enough.
        const oldInvoice = await findActiveInvoice(sp, orderId);
        const creditNote = oldInvoice ? await issueFullCreditNote(ctx, sp, orderId) : null;
        await applyChanges(sp);
        const invoice = await issueInvoiceInTransaction(ctx, sp, orderId);
        return {
          creditNote,
          oldInvoiceNumber: oldInvoice?.invoiceNumber ?? null,
          invoice,
          oldInvoiceIssued: null,
          problem: null,
        };
      });
      applied = true;
    } catch (err) {
      if (!(err instanceof DomainError) || err.status >= 500) throw err;
      docs.problem = err.code;
    }
  }
  if (!applied) await applyChanges(tx);
  // Invoicing switched off while an invoice exists, or the correction failed: the invoice in
  // force is stale. Finance sees it in the to-do list and repairs it (`repairOrderInvoice`).
  if (!p.invoicingEnabled && (await findActiveInvoice(tx, orderId))) {
    docs.problem = 'INVOICING_DISABLED';
  }
  if (docs.problem) {
    await tx.insert(orderHistory).values({
      orderId,
      type: 'invoice_correction_needed',
      actorType: 'SYSTEM',
      data: { adjustmentId: adjustment.id, code: docs.problem },
    });
  }

  // ── Tickets: new QR codes showing the new tariff (check-in state is carried over) ──
  const valid = await tx
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        inArray(
          tickets.orderItemId,
          changed.map((c) => c.item.id),
        ),
        eq(tickets.status, 'VALID'),
      ),
    );
  for (const t of valid) await reissueTicketInTransaction(ctx, tx, t.id);

  if (adjustment.status === 'PROPOSED' && p.paymentId) {
    // Money counts as confirmation (bank transfer sent straight away).
    await tx.insert(orderHistory).values({
      orderId,
      type: 'adjustment_confirmed',
      actorType: p.actor.type,
      actorUserId: p.actor.userId ?? null,
      data: { adjustmentId: adjustment.id, amount: adjustment.amount, viaPayment: true },
    });
  }
  await tx.insert(orderHistory).values({
    orderId,
    type: 'adjustment_paid',
    actorType: p.actor.type,
    actorUserId: p.actor.userId ?? null,
    data: {
      adjustmentId: adjustment.id,
      paymentId: p.paymentId,
      method: p.method,
      amount: p.cash,
      difference,
      creditUsed: p.creditUsed,
      settledByCredit: p.paymentId === null,
      previouslyPaid: p.previouslyPaid,
      items: adjustment.items,
      creditNote: docs.creditNote?.number ?? null,
      invoice: docs.invoice?.invoiceNumber ?? null,
      ticketsReissued: valid.length,
      ...(docs.problem ? { invoiceProblem: docs.problem } : {}),
    },
  });

  let messageId: string | null = null;
  // A change settled by credit changes the tickets: the customer always gets the new ones.
  if (order.email && (p.paymentId !== null || p.notify || valid.length > 0)) {
    // Credit note (invoice correction) + new invoice + the new tickets; the mail explains them.
    const attachments: EmailAttachment[] = [
      ...(docs.creditNote ? [{ type: 'invoice' as const, invoiceId: docs.creditNote.id }] : []),
      ...(docs.invoice ? [{ type: 'invoice' as const, invoiceId: docs.invoice.invoiceId }] : []),
      ...(valid.length > 0 ? [{ type: 'tickets' as const, orderId }] : []),
    ];
    messageId = await createEmailMessage(ctx, tx, {
      key:
        p.paymentId === null
          ? 'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT'
          : 'ADDITIONAL_PAYMENT_RECEIVED',
      orderId,
      attachments,
      variables: {
        adjustmentId: adjustment.id,
        adjustmentNewTotalCents: order.totalGross + difference,
        adjustmentPreviouslyPaidCents: p.previouslyPaid,
        adjustmentOldInvoiceNumber: docs.oldInvoiceNumber ?? null,
        adjustmentNewInvoiceNumber: docs.invoice?.invoiceNumber ?? null,
        adjustmentCreditNoteNumber: docs.creditNote?.number ?? null,
      },
    });
    await tx
      .update(emailMessages)
      .set({ paidCycle: order.paidCycle })
      .where(eq(emailMessages.id, messageId));
  }
  return {
    renders: [docs.oldInvoiceIssued, docs.creditNote?.id, docs.invoice?.invoiceId].filter(
      (id): id is string => Boolean(id),
    ),
    messageId,
  };
}

/** After the commit: invoice PDFs and the customer e-mail (both retried by sweepers on failure). */
async function afterAdjustmentCommit(
  ctx: CoreContext,
  outcome: { renders?: string[]; messageId?: string | null },
): Promise<void> {
  for (const invoiceId of outcome.renders ?? []) {
    await enqueueInvoiceRender(ctx, invoiceId).catch((err: unknown) =>
      console.error('[adjustments] invoice PDF not queued (rendered on first download)', err),
    );
  }
  if (outcome.messageId) {
    await dispatchEmailMessage(ctx, outcome.messageId).catch((err: unknown) =>
      console.error('[adjustments] e-mail stored but not queued (outbox retries)', err),
    );
  }
}

export async function completeAdjustment(
  ctx: CoreContext,
  receipt: AdjustmentPaymentReceipt,
): Promise<CompleteAdjustmentResult> {
  if (!Number.isInteger(receipt.amount) || receipt.amount <= 0) {
    throw new DomainError('INVALID_AMOUNT', 'Payment amount must be positive', 422);
  }
  const [head] = await ctx.db
    .select({ orderId: orderAdjustments.orderId })
    .from(orderAdjustments)
    .where(eq(orderAdjustments.id, receipt.adjustmentId));
  if (!head) throw new DomainError('ADJUSTMENT_NOT_FOUND', 'Additional payment not found', 404);
  const orderId = head.orderId;
  const invoicing = await getSetting(ctx, 'invoicing');

  const outcome = await withTransaction<{
    result: CompleteAdjustmentResult;
    renders?: string[];
    messageId?: string | null;
  }>(ctx.db, async (tx) => {
    await lockOrderTickets(tx, orderId);
    const duplicate = await findDuplicate(tx, receipt);
    if (duplicate) {
      return {
        result: {
          status: 'DUPLICATE',
          adjustmentId: receipt.adjustmentId,
          orderId,
          paymentId: duplicate,
        } as const,
      };
    }
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    const [adjustment] = await tx
      .select()
      .from(orderAdjustments)
      .where(eq(orderAdjustments.id, receipt.adjustmentId))
      .for('update');
    if (!adjustment)
      throw new DomainError('ADJUSTMENT_NOT_FOUND', 'Additional payment not found', 404);
    const refuse = (reason: NotPayableReason) => ({
      result: {
        status: 'NOT_PAYABLE',
        adjustmentId: adjustment.id,
        orderId,
        reason,
        expectedAmount: adjustment.amount,
      } as const,
    });
    if (adjustment.status === 'CANCELLED') return refuse('ADJUSTMENT_CANCELLED');
    if (adjustment.status === 'PAID') return refuse('ADJUSTMENT_PAID');
    if (order.status !== 'PAID') return refuse('ORDER_NOT_PAID');
    if (receipt.currency !== adjustment.currency) return refuse('CURRENCY_MISMATCH');
    if (receipt.amount !== adjustment.amount) return refuse('AMOUNT_MISMATCH');

    const locked = await lockAdjustmentItems(tx, adjustment.items);
    if (!locked.ok) {
      // The ticket changed after the request: it can never be applied. Cancel it so reminders
      // stop; PayPal money is refunded, a bank transfer goes to the Klärfälle.
      const cancelled = await cancelOpenAdjustmentInTransaction(tx, orderId, {
        actor: { type: 'SYSTEM' },
        reason: 'ITEMS_CHANGED',
      });
      const voidMail = cancelled ? await queueAdjustmentCancelledMail(ctx, tx, cancelled) : null;
      return { ...refuse('ITEMS_CHANGED'), messageId: voidMail };
    }

    // Net money received so far (refunded money does not count) and the overpayment credited at
    // proposal time: it must still be there, otherwise the amount to pay is higher than requested.
    const previouslyPaid = await orderNetPaid(tx, orderId);
    if (adjustment.creditApplied > 0) {
      const { credit } = await orderCredit(tx, order);
      if (credit < adjustment.creditApplied) {
        // The amount to pay is higher than requested and can never be met: cancel the request
        // (reminders stop, the customer is told); PayPal money is refunded, bank money goes to
        // the Klärfälle.
        const cancelled = await cancelOpenAdjustmentInTransaction(tx, orderId, {
          actor: { type: 'SYSTEM' },
          reason: 'CREDIT_CHANGED',
        });
        const voidMail = cancelled ? await queueAdjustmentCancelledMail(ctx, tx, cancelled) : null;
        return { ...refuse('CREDIT_CHANGED'), messageId: voidMail };
      }
    }
    const now = new Date();
    const capturedAt = receipt.capturedAt ?? now;
    const captured = {
      status: 'CAPTURED' as const,
      amount: receipt.amount,
      currency: receipt.currency,
      adjustmentId: adjustment.id,
      providerCaptureId: receipt.providerCaptureId ?? null,
      bankTransactionId: receipt.bankTransactionId ?? null,
      receivedByUserId: receipt.receivedByUserId ?? null,
      providerResponse: receipt.providerResponse ?? null,
      capturedAt,
      failureCode: null,
      failureMessage: null,
    };
    // A PayPal attempt (CREATED / APPROVED row) is completed in place.
    const [attempt] = receipt.providerOrderId
      ? await tx
          .select({ id: payments.id, status: payments.status })
          .from(payments)
          .where(
            and(
              eq(payments.method, receipt.method),
              eq(payments.providerOrderId, receipt.providerOrderId),
            ),
          )
      : [];
    if (attempt?.status === 'CAPTURED') {
      return {
        result: {
          status: 'DUPLICATE',
          adjustmentId: adjustment.id,
          orderId,
          paymentId: attempt.id,
        } as const,
      };
    }
    const [payment] = attempt
      ? await tx
          .update(payments)
          .set({ ...captured, updatedAt: now })
          .where(eq(payments.id, attempt.id))
          .returning({ id: payments.id })
      : await tx
          .insert(payments)
          .values({
            orderId,
            method: receipt.method,
            providerOrderId: receipt.providerOrderId ?? null,
            ...captured,
          })
          .returning({ id: payments.id });

    // The other PayPal attempts of this adjustment are obsolete now.
    await tx
      .update(payments)
      .set({ status: 'CANCELLED', failureCode: 'ADJUSTMENT_PAID', updatedAt: now })
      .where(
        and(
          eq(payments.adjustmentId, adjustment.id),
          ne(payments.id, payment!.id),
          inArray(payments.status, ['CREATED', 'APPROVED']),
        ),
      );

    const applied = await applyAdjustmentInTransaction(ctx, tx, {
      order,
      adjustment,
      itemById: locked.itemById,
      paymentId: payment!.id,
      method: receipt.method,
      cash: receipt.amount,
      creditUsed: adjustment.creditApplied,
      previouslyPaid,
      capturedAt,
      actor: receipt.actor,
      notify: true,
      invoicingEnabled: invoicing.issueInvoices,
    });
    return {
      result: {
        status: 'PAID',
        adjustmentId: adjustment.id,
        orderId,
        paymentId: payment!.id,
      } as const,
      renders: applied.renders,
      messageId: applied.messageId,
    };
  });

  await afterAdjustmentCommit(ctx, outcome);
  return outcome.result;
}

async function findDuplicate(
  tx: Transaction,
  receipt: AdjustmentPaymentReceipt,
): Promise<string | null> {
  if (receipt.providerCaptureId) {
    const [row] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.providerCaptureId, receipt.providerCaptureId),
          inArray(payments.status, ['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED']),
        ),
      );
    if (row) return row.id;
  }
  if (receipt.bankTransactionId) {
    const [row] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.bankTransactionId, receipt.bankTransactionId),
          eq(payments.adjustmentId, receipt.adjustmentId),
          ne(payments.status, 'CANCELLED'),
        ),
      );
    if (row) return row.id;
  }
  return null;
}

// ─── Reminder (dunning job) ─────────────────────────────────────────────────

const REMINDER_BATCH = 200;

/**
 * One automatic reminder per open adjustment, `bankTransfer.adjustmentReminderDays` after it was
 * proposed. Claimed with a conditional UPDATE (safe in parallel); an order without an e-mail
 * address still gets `reminder_sent_at`, so the adjustment shows up in the admin's open notice.
 * No automatic cancellation – the admin decides.
 */
export async function sendAdjustmentReminders(ctx: CoreContext, now = new Date()): Promise<number> {
  const { adjustmentReminderDays } = await getSetting(ctx, 'bankTransfer');
  const cutoff = new Date(now.getTime() - adjustmentReminderDays * 86_400_000);
  const due = await ctx.db
    .select({ id: orderAdjustments.id })
    .from(orderAdjustments)
    .where(
      and(
        inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
        isNull(orderAdjustments.reminderSentAt),
        lte(orderAdjustments.createdAt, cutoff),
      ),
    )
    .orderBy(asc(orderAdjustments.createdAt))
    .limit(REMINDER_BATCH);
  let sent = 0;
  for (const { id } of due) {
    try {
      const messageId = await withTransaction(ctx.db, async (tx) => {
        const [claimed] = await tx
          .update(orderAdjustments)
          .set({ reminderSentAt: now, updatedAt: now })
          .where(
            and(
              eq(orderAdjustments.id, id),
              inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
              isNull(orderAdjustments.reminderSentAt),
            ),
          )
          .returning({ orderId: orderAdjustments.orderId, amount: orderAdjustments.amount });
        if (!claimed) return undefined;
        const [order] = await tx
          .select({ email: orders.email })
          .from(orders)
          .where(eq(orders.id, claimed.orderId));
        await tx.insert(orderHistory).values({
          orderId: claimed.orderId,
          type: 'adjustment_reminder_sent',
          actorType: 'SYSTEM',
          data: { adjustmentId: id, amount: claimed.amount, mailed: Boolean(order?.email) },
        });
        return order?.email
          ? createEmailMessage(ctx, tx, {
              key: 'ADDITIONAL_PAYMENT_REMINDER',
              orderId: claimed.orderId,
              variables: { adjustmentId: id },
            })
          : null;
      });
      if (messageId === undefined) continue;
      sent += 1;
      if (messageId) {
        await dispatchEmailMessage(ctx, messageId).catch((err: unknown) =>
          console.error('[adjustments] reminder stored but not queued (outbox retries)', err),
        );
      }
    } catch (err) {
      console.error(`[adjustments] reminder failed for adjustment ${id}`, err);
    }
  }
  return sent;
}

// ─── Reads (admin pages, customer order page) ───────────────────────────────

/** All adjustments of an order, newest first. */
export async function listOrderAdjustments(
  ctx: Pick<CoreContext, 'db'>,
  orderId: string,
): Promise<AdjustmentRow[]> {
  return ctx.db
    .select()
    .from(orderAdjustments)
    .where(eq(orderAdjustments.orderId, orderId))
    .orderBy(desc(orderAdjustments.createdAt));
}

export interface OpenAdjustmentListRow extends AdjustmentRow {
  orderNumber: string;
  buyerName: string;
  email: string | null;
  /** The automatic reminder went out and the money is still missing (admin to-do). */
  needsAttention: boolean;
}

/** Open adjustments, those with a sent reminder (the admin's open notice) first. */
export async function listOpenAdjustments(
  ctx: Pick<CoreContext, 'db'>,
): Promise<OpenAdjustmentListRow[]> {
  const rows = await ctx.db
    .select({
      adjustment: orderAdjustments,
      orderNumber: orders.orderNumber,
      firstName: orders.firstName,
      lastName: orders.lastName,
      email: orders.email,
    })
    .from(orderAdjustments)
    .innerJoin(orders, eq(orders.id, orderAdjustments.orderId))
    .where(inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]))
    .orderBy(asc(orderAdjustments.createdAt));
  return rows
    .map((r) => ({
      ...r.adjustment,
      orderNumber: r.orderNumber,
      buyerName: `${r.firstName} ${r.lastName}`.trim(),
      email: r.email,
      needsAttention: r.adjustment.reminderSentAt !== null,
    }))
    .sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention));
}

/** Number of open adjustments whose reminder was sent (nav badge, dashboard alert). */
export async function countAdjustmentsNeedingAttention(
  ctx: Pick<CoreContext, 'db'>,
): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orderAdjustments)
    .where(
      and(
        inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
        isNotNull(orderAdjustments.reminderSentAt),
      ),
    );
  return row?.n ?? 0;
}

export interface AdjustmentPaymentOptions {
  paypal: boolean;
  bank: { holder: string; iban: string; bic: string | null; bankName: string | null } | null;
}

/**
 * How the customer can pay an adjustment: the payment-method switches of the event(s) of the
 * adjusted tickets (global setting, event override, PayPal configured, default bank account).
 * The "too close to the event" rule of new orders does not apply: the tickets are paid already.
 */
export async function getAdjustmentPaymentOptions(
  ctx: CoreContext,
  adjustment: AdjustmentRow,
): Promise<AdjustmentPaymentOptions> {
  const eventRows = await ctx.db
    .selectDistinct({
      startsAt: events.startsAt,
      bankTransferEnabled: events.bankTransferEnabled,
      bankTransferDisableDaysBeforeEvent: events.bankTransferDisableDaysBeforeEvent,
      paypalEnabled: events.paypalEnabled,
    })
    .from(orderItems)
    .innerJoin(events, eq(events.id, orderItems.eventId))
    .where(
      inArray(
        orderItems.id,
        adjustment.items.map((i) => i.orderItemId),
      ),
    );
  const availability = await paymentAvailabilityForEvents(ctx, eventRows);
  const bankOk =
    availability.BANK_TRANSFER === null || availability.BANK_TRANSFER === 'TOO_CLOSE_TO_EVENT';
  const [account] = bankOk
    ? await ctx.db
        .select()
        .from(bankAccounts)
        .where(
          and(eq(bankAccounts.isDefaultForBankTransfer, true), eq(bankAccounts.isActive, true)),
        )
        .limit(1)
    : [];
  return {
    paypal: availability.PAYPAL === null,
    bank: account
      ? {
          holder: account.accountHolder,
          iban: account.iban,
          bic: account.bic ?? null,
          bankName: account.bankName ?? null,
        }
      : null,
  };
}

export interface TariffChangeOptions {
  orderItemId: string;
  /** Higher-priced tariffs offered for the ticket (current price matrix of the order's channel). */
  options: { id: string; name: string; priceGross: number }[];
}

/** For the admin form: per active ticket the tariffs it could be switched to (price > paid). */
export async function getTariffChangeOptions(
  ctx: CoreContext,
  orderId: string,
): Promise<TariffChangeOptions[]> {
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  const items = await ctx.db
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'CONFIRMED')))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const maps = new Map<string, Awaited<ReturnType<typeof getSeatMapForChannel>>>();
  for (const eventId of [...new Set(items.map((i) => i.eventId))].sort()) {
    maps.set(
      eventId,
      await getSeatMapForChannel(ctx, await getEventCached(ctx, eventId), order.channel),
    );
  }
  return items.map((item) => {
    const map = maps.get(item.eventId)!;
    const seat = item.seatId ? seatIndex(map).get(item.seatId) : undefined;
    const options = allowedTypesFor(map, item.priceCategoryId, seat ? seat.f : null)
      .filter(
        (t) =>
          t.id !== item.ticketTypeId && (t.prices[item.priceCategoryId] ?? 0) > item.priceGross,
      )
      .map((t) => ({ id: t.id, name: t.name, priceGross: t.prices[item.priceCategoryId]! }))
      .sort((a, b) => a.priceGross - b.priceGross);
    return { orderItemId: item.id, options };
  });
}

// ─── Invoice correction to-do (GoBD) ────────────────────────────────────────

/**
 * The invoice in force of the order is older than its last paid additional payment: the
 * automatic correction (credit note + new invoice) did not happen (document problem, invoicing
 * switched off meanwhile). Self-healing: once a newer invoice is in force the order drops out.
 */
const staleInvoiceExists = sql`
  exists (
    select 1 from invoices i
    where i.order_id = ${orderAdjustments.orderId} and i.type = 'INVOICE'
      and i.issued_at < ${orderAdjustments.updatedAt}
      and not exists (select 1 from invoice_supersessions s where s.invoice_id = i.id)
  )
  and not exists (
    select 1 from invoices n
    where n.order_id = ${orderAdjustments.orderId} and n.type = 'INVOICE'
      and n.issued_at >= ${orderAdjustments.updatedAt}
      and not exists (select 1 from invoice_supersessions s2 where s2.invoice_id = n.id)
  )`;

export interface InvoiceCorrectionRow {
  orderId: string;
  orderNumber: string;
  buyerName: string;
  adjustmentId: string;
  amount: number;
  currency: string;
  paidAt: Date | null;
}

export async function listInvoiceCorrections(
  ctx: Pick<CoreContext, 'db'>,
): Promise<InvoiceCorrectionRow[]> {
  const rows = await ctx.db
    .select({
      adjustment: orderAdjustments,
      orderNumber: orders.orderNumber,
      firstName: orders.firstName,
      lastName: orders.lastName,
    })
    .from(orderAdjustments)
    .innerJoin(orders, eq(orders.id, orderAdjustments.orderId))
    .where(and(eq(orderAdjustments.status, 'PAID'), staleInvoiceExists))
    .orderBy(asc(orderAdjustments.updatedAt));
  const byOrder = new Map<string, InvoiceCorrectionRow>();
  for (const r of rows) {
    byOrder.set(r.adjustment.orderId, {
      orderId: r.adjustment.orderId,
      orderNumber: r.orderNumber,
      buyerName: `${r.firstName} ${r.lastName}`.trim(),
      adjustmentId: r.adjustment.id,
      // The whole price difference (cash + credited overpayment).
      amount: r.adjustment.amount + r.adjustment.creditApplied,
      currency: r.adjustment.currency,
      paidAt: r.adjustment.paidAt,
    });
  }
  return [...byOrder.values()];
}

export async function countInvoiceCorrections(ctx: Pick<CoreContext, 'db'>): Promise<number> {
  return (await listInvoiceCorrections(ctx)).length;
}

/**
 * "Rechnung korrigieren": negates the invoice in force completely (credit note) and issues a new
 * invoice over the current order. Idempotent – does nothing when the invoice is up to date.
 */
export async function repairOrderInvoice(
  ctx: CoreContext,
  params: { orderId: string; userId: string },
): Promise<{ repaired: boolean }> {
  const outcome = await withTransaction(ctx.db, async (tx) => {
    await lockOrderTickets(tx, params.orderId);
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    const [stale] = await tx
      .select({ id: orderAdjustments.id })
      .from(orderAdjustments)
      .where(
        and(
          eq(orderAdjustments.orderId, params.orderId),
          eq(orderAdjustments.status, 'PAID'),
          staleInvoiceExists,
        ),
      )
      .limit(1);
    if (!stale) return null;
    if (order.status !== 'PAID') {
      throw new DomainError(
        'INVOICE_REPAIR_NOT_POSSIBLE',
        'The invoice of a refunded order cannot be repaired automatically',
        409,
      );
    }
    const creditNote = await issueFullCreditNote(ctx, tx, params.orderId);
    const invoice = await issueInvoiceInTransaction(ctx, tx, params.orderId, { force: true });
    await tx.insert(orderHistory).values({
      orderId: params.orderId,
      type: 'invoice_corrected',
      actorType: 'ADMIN',
      actorUserId: params.userId,
      data: {
        adjustmentId: stale.id,
        creditNote: creditNote?.number ?? null,
        invoice: invoice?.invoiceNumber ?? null,
      },
    });
    return [creditNote?.id, invoice?.invoiceId].filter((id): id is string => Boolean(id));
  });
  if (!outcome) return { repaired: false };
  for (const invoiceId of outcome) {
    await enqueueInvoiceRender(ctx, invoiceId).catch((err: unknown) =>
      console.error('[adjustments] invoice PDF not queued (rendered on first download)', err),
    );
  }
  return { repaired: true };
}
