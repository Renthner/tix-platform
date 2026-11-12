import { coreLog } from '../log';
import { randomUUID } from 'node:crypto';
import {
  bankTransactions,
  invoiceLines,
  invoiceSupersessions,
  invoices,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  payments,
  refundItems,
  refunds,
  seatMapSections,
  withTransaction,
  type Transaction,
} from '@tix/db';
import type { OrderStatus, PaymentMethod, TaxBreakdownEntry } from '@tix/shared';
import { splitGross } from '@tix/shared';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage, type EmailAttachment } from '../email';
import { formatMoney } from '../format';
import { enqueueInvoiceRender, findActiveInvoice, issueInvoiceInTransaction } from '../invoices';
import { QUEUE_NAMES } from '../job-queues';
import { nextNumber } from '../numbering';
import {
  createPayPalRefund,
  getPayPalRefund,
  getPayPalRefundDetails,
  isTransientPayPalError,
} from '../payments/paypal';
import { getSetting } from '../settings';
import { lockOrderTickets, voidTicketsForItems } from '../tickets/issue';
import {
  cancelOpenAdjustmentInTransaction,
  findOpenAdjustment,
  queueAdjustmentCancelledMail,
} from './adjustment-state';
import { creditOf, creditedFeeAmounts, currentWriteOff, orderCredit, orderNetPaid } from './credit';
import { releaseInventory } from './fulfillment';
import {
  hasOpenRefundReview,
  isRefundReconcilePending,
  markRefundSucceeded,
  MONEY_RESERVING_REFUND_STATUSES,
  resolveReviewIfOnly,
} from './refund-state';

/**
 * Cancellation of PAID orders (whole order or single tickets) with refund and credit note.
 *
 * `cancelPaidOrder` does everything that must be atomic in ONE transaction: items REFUNDED,
 * tickets voided, standing capacity returned, refund rows (money actually received, capped),
 * the credit note (GoBD, gapless number) and the e-mail outbox row. After the commit it releases
 * the seats (Redis mirror + live broadcast), queues the PayPal refund jobs, renders the credit
 * note PDF and dispatches the e-mail.
 *
 * Refund rules
 *  - PayPal payments with a capture id are refunded automatically (`kind AUTOMATIC`, job
 *    `execute-refund`). Everything else (bank transfer, cash, card, PayPal without capture)
 *    becomes a MANUAL "Erstattung offen" to-do with a payer IBAN/name snapshot (from the bank
 *    transaction of the payment) that finance marks as done.
 *  - Refund money is capped by what was received: per payment `amount` minus all refund rows
 *    that already claim it (PENDING, SUCCEEDED and FAILED). A written-off bank shortfall is
 *    therefore never paid back, while the credit note still negates the invoice lines in full.
 *    Payments are used PayPal-with-capture first, then others, newest first.
 *  - Fees (only when `refundFees`): a PER_TICKET fee line is refunded per cancelled ticket of its
 *    event (`floor(line total × cancelled / line quantity)`, the remaining amount when all
 *    tickets of the line are cancelled – integer cents, never exceeding what is left of the
 *    line); PER_EVENT fees once no CONFIRMED item of the event remains, PER_ORDER fees once no
 *    CONFIRMED item of the order remains. Already refunded fee amounts are read from
 *    `refund_items.order_fee_id`.
 *  - `refund_items` hold the money allocation of a refund row (sequentially: items first, then
 *    fees), so Σ refund_items.amount = refunds.amount.
 */

export interface CancelPaidOrderParams {
  orderId: string;
  /** Items to cancel; omitted = every active (CONFIRMED) item = whole order. */
  orderItemIds?: string[];
  /** Refund the service fees as well (the admin decides per cancellation). */
  refundFees: boolean;
  reason?: string | null;
  /** Send the REFUND_CONFIRMATION e-mail (credit note attached). */
  notify: boolean;
  userId: string;
  /** Optimistic concurrency guard against a stale admin page. */
  expectedVersion?: number;
  /**
   * The refund of this cancellation already exists at PayPal (lost window / PayPal dashboard,
   * verified live by `recordExistingPayPalRefund`): the refund row is created as SUCCEEDED with
   * this PayPal refund id and nothing is sent.
   */
  existingPaypalRefund?: { providerRefundId: string; paymentId: string; amount: number };
  /** Runs inside the business transaction at the end (e.g. the audit entry). */
  inTransaction?: (tx: Transaction, result: CancelPaidOrderResult) => Promise<void>;
}

export interface CancelPaidOrderResult {
  orderStatus: OrderStatus;
  cancelledItems: number;
  /** Value of the cancelled items (+ fees) – what the credit note negates. */
  creditTotal: number;
  /** Money that will be / was paid back (can be lower than `creditTotal`, or higher with an overpayment). */
  refundTotal: number;
  /** Part of `refundTotal` that pays back an overpayment (a whole cancellation returns the excess too). */
  overpaymentRefunded: number;
  /** All refund rows of this cancellation share one batch (one amount for the admin). */
  batchId: string;
  refunds: { id: string; kind: 'AUTOMATIC' | 'MANUAL'; amount: number; method: PaymentMethod }[];
  creditNote: { id: string; number: string } | null;
  /**
   * An open additional payment (tariff change) of the order was cancelled together with this
   * cancellation (the order is no longer fully PAID, so it could not be applied any more).
   */
  cancelledAdjustment: { id: string; amount: number; reference: string } | null;
}

interface Component {
  kind: 'item' | 'fee';
  id: string;
  /** Credit value of the component. */
  amount: number;
}

const REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = ['PAID', 'PARTIALLY_REFUNDED'];

export async function cancelPaidOrder(
  ctx: CoreContext,
  params: CancelPaidOrderParams,
): Promise<CancelPaidOrderResult> {
  const outcome = await withTransaction(ctx.db, async (tx) => {
    // Ticket advisory lock first (same order as ensureOrderTickets / reissueTicket / reversal).
    await lockOrderTickets(tx, params.orderId);
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) {
      throw new DomainError('ORDER_NOT_REFUNDABLE', 'Only paid orders can be cancelled here', 409, {
        status: order.status,
      });
    }
    if (params.expectedVersion !== undefined && params.expectedVersion !== order.version) {
      throw new DomainError('ORDER_CHANGED', 'The order was changed in the meantime', 409);
    }

    // The invoice is issued asynchronously after payment; make sure it exists so the credit
    // note has something to correct (idempotent, same transaction).
    let issuedInvoiceId: string | null = null;
    let invoiceProblem: string | null = null;
    try {
      const invoice = await issueInvoiceInTransaction(ctx, tx, order.id);
      if (invoice?.created) issuedInvoiceId = invoice.invoiceId;
    } catch (err) {
      // Inconsistent historic data must not block the cancellation (admin issues documents by hand).
      if (!(err instanceof DomainError) || err.status >= 500) throw err;
      invoiceProblem = err.code;
    }

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const active = items.filter((i) => i.status === 'CONFIRMED');
    let selected = active;
    if (params.orderItemIds) {
      const wanted = new Set(params.orderItemIds);
      selected = active.filter((i) => wanted.has(i.id));
      if (wanted.size === 0 || selected.length !== wanted.size) {
        throw new DomainError(
          'ITEMS_NOT_REFUNDABLE',
          'Some tickets are not active any more (already cancelled or refunded)',
          409,
        );
      }
    }
    if (selected.length === 0) {
      throw new DomainError('ITEMS_NOT_REFUNDABLE', 'The order has no active tickets', 409);
    }
    const selectedIds = new Set(selected.map((i) => i.id));
    const cancelledAdjustment = await cancelOpenAdjustmentInTransaction(tx, order.id, {
      actor: { type: 'ADMIN', userId: params.userId },
      reason: 'TICKETS_CANCELLED',
    });
    const adjustmentMessageId = cancelledAdjustment
      ? await queueAdjustmentCancelledMail(ctx, tx, cancelledAdjustment)
      : null;
    const remainingActive = active.filter((i) => !selectedIds.has(i.id));
    const now = new Date();

    // ── Inventory ───────────────────────────────────────────────────────────
    await tx
      .update(orderItems)
      .set({ status: 'REFUNDED', refundedAt: now })
      .where(inArray(orderItems.id, [...selectedIds]));
    await voidTicketsForItems(tx, [...selectedIds], 'REFUNDED');
    const gaBySection = new Map<string, number>();
    for (const item of selected) {
      if (item.kind === 'GENERAL_ADMISSION') {
        gaBySection.set(item.sectionId, (gaBySection.get(item.sectionId) ?? 0) + 1);
      }
    }
    for (const [sectionId, n] of [...gaBySection].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      await tx
        .update(seatMapSections)
        .set({ allocatedCount: sql`GREATEST(${seatMapSections.allocatedCount} - ${n}, 0)` })
        .where(eq(seatMapSections.id, sectionId));
    }

    // ── What is credited ────────────────────────────────────────────────────
    const components: Component[] = selected.map((i) => ({
      kind: 'item',
      id: i.id,
      amount: i.priceGross,
    }));
    const feeAmounts = params.refundFees
      ? await refundableFees(tx, order.id, selected, remainingActive)
      : new Map<string, FeeRefund>();
    for (const [feeId, fee] of feeAmounts) {
      components.push({ kind: 'fee', id: feeId, amount: fee.amount });
    }
    const creditTotal = components.reduce((sum, c) => sum + c.amount, 0);

    // ── Refund rows (money actually received, capped) ───────────────────────
    const existing = params.existingPaypalRefund;
    const rows = await planRefunds(tx, order.id, components, 'PAYPAL_FIRST', existing?.paymentId);
    // An order under review (PayPal already refunded something we do not know about) must not
    // get a second automatic refund: the admin records the existing one first.
    const reviewOpen = await hasOpenRefundReview(tx, order.id);
    const automaticPlans = rows.filter((plan) => plan.kind === 'AUTOMATIC');
    if (existing) {
      const [only] = automaticPlans;
      if (
        automaticPlans.length !== 1 ||
        only!.payment.id !== existing.paymentId ||
        only!.amount !== existing.amount
      ) {
        throw new DomainError(
          'REFUND_EXISTING_MISMATCH',
          'The selected tickets/fees do not add up to the PayPal refund',
          409,
          {
            paypalAmount: existing.amount,
            plannedAmounts: automaticPlans.map((plan) => plan.amount),
          },
        );
      }
    } else if (reviewOpen && automaticPlans.length > 0) {
      throw new DomainError(
        'REFUND_REVIEW_OPEN',
        'PayPal refunds of this order are on hold: resolve the refund review first',
        409,
      );
    }
    const batchId = randomUUID();
    const refundRows: CancelPaidOrderResult['refunds'] = [];
    const newRefundIds: string[] = [];
    let recordedRefundId: string | null = null;
    for (const plan of rows) {
      const [row] = await tx
        .insert(refunds)
        .values({
          orderId: order.id,
          batchId,
          paymentId: plan.payment.id,
          method: plan.payment.method,
          kind: plan.kind,
          status: 'PENDING',
          amount: plan.amount,
          currency: order.currency,
          reason: params.reason?.trim() || null,
          refundFees: params.refundFees,
          payerIban: plan.payerIban,
          payerName: plan.payerName,
          requestedByUserId: params.userId,
          ...(existing && plan.kind === 'AUTOMATIC'
            ? { providerRefundId: existing.providerRefundId }
            : {}),
        })
        .returning({ id: refunds.id });
      await tx.insert(refundItems).values(
        plan.allocations.map((a) => ({
          refundId: row!.id,
          orderItemId: a.kind === 'item' ? a.id : null,
          orderFeeId: a.kind === 'fee' ? a.id : null,
          amount: a.amount,
        })),
      );
      newRefundIds.push(row!.id);
      if (existing && plan.kind === 'AUTOMATIC') {
        // Already refunded at PayPal: settle now (totals are recomputed), never send.
        await markRefundSucceeded(tx, row!.id, {
          providerRefundId: existing.providerRefundId,
          actor: { type: 'ADMIN', userId: params.userId },
          note: 'Existing PayPal refund recorded',
        });
        recordedRefundId = row!.id;
      }
      refundRows.push({
        id: row!.id,
        kind: plan.kind,
        amount: plan.amount,
        method: plan.payment.method,
      });
    }
    // A whole cancellation also pays back an overpayment that would otherwise stay invisible on a
    // REFUNDED order: the excess net money is planned into the same batch (newest money first).
    let overpaymentRefunded = 0;
    // (Not when an existing PayPal refund is recorded: the excess stays refundable on its own.)
    if (remainingActive.length === 0 && !existing) {
      // What stays owed after a whole cancellation: fees that were kept (not credited).
      const feeRows = await tx.select().from(orderFees).where(eq(orderFees.orderId, order.id));
      const creditedBefore = await creditedFeeAmounts(
        tx,
        order.id,
        feeRows.map((f) => f.id),
      );
      const keptFees = feeRows.reduce(
        (sum, f) =>
          sum +
          Math.max(
            0,
            f.totalGross -
              (creditedBefore.get(f.id)?.gross ?? 0) -
              (feeAmounts.get(f.id)?.amount ?? 0),
          ),
        0,
      );
      // Net money after this cancellation's refund rows (inserted above) against what stays owed.
      const [netNow, writeOff] = await Promise.all([
        orderNetPaid(tx, order.id),
        currentWriteOff(tx, order),
      ]);
      const leftover = creditOf(netNow, keptFees, writeOff);
      if (leftover > 0) {
        const extra = await planRefunds(
          tx,
          order.id,
          [{ kind: 'item', id: order.id, amount: leftover }],
          'NEWEST_FIRST',
        );
        for (const plan of extra) {
          if (plan.kind === 'AUTOMATIC' && (existing || reviewOpen)) {
            throw new DomainError(
              'REFUND_REVIEW_OPEN',
              'PayPal refunds of this order are on hold: resolve the refund review first',
              409,
            );
          }
          const [row] = await tx
            .insert(refunds)
            .values({
              orderId: order.id,
              batchId,
              overpayment: true,
              paymentId: plan.payment.id,
              method: plan.payment.method,
              kind: plan.kind,
              status: 'PENDING',
              amount: plan.amount,
              currency: order.currency,
              reason: OVERPAYMENT_REASON,
              payerIban: plan.payerIban,
              payerName: plan.payerName,
              requestedByUserId: params.userId,
            })
            .returning({ id: refunds.id });
          refundRows.push({
            id: row!.id,
            kind: plan.kind,
            amount: plan.amount,
            method: plan.payment.method,
          });
          overpaymentRefunded += plan.amount;
        }
      }
    }
    if (invoiceProblem) {
      await tx.insert(orderHistory).values({
        orderId: order.id,
        type: 'credit_note_missing',
        actorType: 'SYSTEM',
        data: { code: invoiceProblem },
      });
    }
    const refundTotal = refundRows.reduce((sum, r) => sum + r.amount, 0);
    if (feeAmounts.size > 0) {
      await tx
        .update(orderFees)
        .set({ isRefunded: true })
        .where(
          inArray(
            orderFees.id,
            [...feeAmounts].filter(([, f]) => f.completes).map(([id]) => id),
          ),
        );
    }

    if (existing) {
      // The review only concerned this refund: nothing left to look at.
      await resolveReviewIfOnly(tx, order.id, existing.providerRefundId, params.userId);
    }

    // ── Credit note ─────────────────────────────────────────────────────────
    const creditNote = await issueCreditNote(ctx, tx, {
      orderId: order.id,
      itemIds: selectedIds,
      fees: feeAmounts,
      refundIds: newRefundIds,
    });

    // ── Order state ─────────────────────────────────────────────────────────
    const newStatus: OrderStatus = remainingActive.length === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    await tx
      .update(orders)
      .set({ status: newStatus, version: sql`${orders.version} + 1`, updatedAt: now })
      .where(eq(orders.id, order.id));
    await tx.insert(orderHistory).values({
      orderId: order.id,
      type: 'paid_order_cancelled',
      fromStatus: order.status,
      toStatus: newStatus,
      actorType: 'ADMIN',
      actorUserId: params.userId,
      data: {
        orderItemIds: [...selectedIds],
        refundFees: params.refundFees,
        creditTotal,
        refundTotal,
        overpaymentRefunded,
        batchId,
        refundIds: refundRows.map((r) => r.id),
        creditNote: creditNote?.number ?? null,
        reason: params.reason?.trim() || null,
      },
    });

    // ── Customer e-mail (outbox) ────────────────────────────────────────────
    let messageId: string | null = null;
    // Box-office orders without buyer data have nobody to notify.
    if (params.notify && order.email) {
      const attachments: EmailAttachment[] = creditNote
        ? [{ type: 'invoice', invoiceId: creditNote.id }]
        : [];
      messageId = await createEmailMessage(ctx, tx, {
        key: 'REFUND_CONFIRMATION',
        orderId: order.id,
        attachments,
        variables: {
          refundAmount:
            refundTotal > 0 ? formatMoney(refundTotal, order.currency, order.locale) : null,
          creditNoteNumber: creditNote?.number ?? null,
          refundViaPaypal: refundRows.some((r) => r.kind === 'AUTOMATIC') ? 'yes' : null,
          refundManual: refundRows.some((r) => r.kind === 'MANUAL') ? 'yes' : null,
        },
      });
    }

    const result = {
      orderStatus: newStatus,
      cancelledItems: selected.length,
      creditTotal,
      refundTotal,
      overpaymentRefunded,
      batchId,
      refunds: refundRows,
      creditNote,
      cancelledAdjustment: cancelledAdjustment
        ? {
            id: cancelledAdjustment.id,
            amount: cancelledAdjustment.amount,
            reference: cancelledAdjustment.paymentReference,
          }
        : null,
    } satisfies CancelPaidOrderResult;
    await params.inTransaction?.(tx, result);
    return {
      result,
      released: selected,
      recordedRefundId,
      messageId,
      adjustmentMessageId,
      issuedInvoiceId,
    };
  });

  // ── After commit: inventory, jobs, documents, e-mail ──────────────────────
  // The cancellation is committed: nothing below may turn it into an error for the caller.
  const guarded = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      coreLog.error(
        { err, step: what },
        '[refunds] step failed after the cancellation was committed',
      );
    }
  };
  await guarded('seat release', () => releaseInventory(ctx, outcome.released));
  for (const refund of outcome.result.refunds) {
    if (refund.kind === 'AUTOMATIC' && refund.id !== outcome.recordedRefundId) {
      await guarded('refund job enqueue (sweeper retries)', () => enqueueRefund(ctx, refund.id));
    }
  }
  for (const invoiceId of [outcome.issuedInvoiceId, outcome.result.creditNote?.id]) {
    if (invoiceId) {
      await guarded('invoice PDF enqueue (rendered on first download)', () =>
        enqueueInvoiceRender(ctx, invoiceId),
      );
    }
  }
  if (outcome.adjustmentMessageId) {
    const adjustmentMessageId = outcome.adjustmentMessageId;
    await guarded('adjustment cancellation e-mail dispatch (outbox sweeper retries)', () =>
      dispatchEmailMessage(ctx, adjustmentMessageId),
    );
  }
  if (outcome.messageId) {
    const messageId = outcome.messageId;
    await guarded('e-mail dispatch (outbox sweeper retries)', () =>
      dispatchEmailMessage(ctx, messageId),
    );
  }
  return outcome.result;
}

// ─── Fees ───────────────────────────────────────────────────────────────────

interface FeeRefund {
  amount: number;
  /** Units (tickets) the credit-note line covers. */
  quantity: number;
  /** The fee line is fully refunded with this amount. */
  completes: boolean;
}

async function refundableFees(
  tx: Transaction,
  orderId: string,
  selected: { eventId: string }[],
  remainingActive: { eventId: string }[],
): Promise<Map<string, FeeRefund>> {
  const feeRows = await tx.select().from(orderFees).where(eq(orderFees.orderId, orderId));
  if (feeRows.length === 0) return new Map();
  const creditedBy = await creditedFeeAmounts(
    tx,
    orderId,
    feeRows.map((f) => f.id),
  );
  const cancelledPerEvent = new Map<string, number>();
  for (const item of selected) {
    cancelledPerEvent.set(item.eventId, (cancelledPerEvent.get(item.eventId) ?? 0) + 1);
  }
  const stillActive = (eventId: string) => remainingActive.some((i) => i.eventId === eventId);

  const result = new Map<string, FeeRefund>();
  for (const fee of feeRows) {
    const left = fee.totalGross - (creditedBy.get(fee.id)?.gross ?? 0);
    if (fee.totalGross === 0 || left <= 0) continue;
    if (fee.scope === 'PER_TICKET') {
      const cancelled = cancelledPerEvent.get(fee.eventId!) ?? 0;
      if (cancelled === 0) continue;
      const units = Math.min(cancelled, fee.quantity);
      // The last active ticket of the event takes the remainder (no cent drift, also when the
      // tickets were cancelled one by one); otherwise the proportional share.
      const amount = stillActive(fee.eventId!)
        ? Math.min(left, Math.floor((fee.totalGross * units) / fee.quantity))
        : left;
      if (amount > 0) {
        result.set(fee.id, { amount, quantity: units, completes: amount === left });
      }
    } else if (fee.scope === 'PER_EVENT') {
      if (cancelledPerEvent.has(fee.eventId!) && !stillActive(fee.eventId!)) {
        result.set(fee.id, { amount: left, quantity: fee.quantity, completes: true });
      }
    } else if (remainingActive.length === 0) {
      result.set(fee.id, { amount: left, quantity: fee.quantity, completes: true });
    }
  }
  return result;
}

// ─── Money allocation ───────────────────────────────────────────────────────

interface RefundPlan {
  payment: typeof payments.$inferSelect;
  kind: 'AUTOMATIC' | 'MANUAL';
  amount: number;
  payerIban: string | null;
  payerName: string | null;
  allocations: Component[];
}

async function planRefunds(
  tx: Transaction,
  orderId: string,
  components: Component[],
  /**
   * Which payments pay first: PayPal captures (refunded automatically), then the others – or,
   * for an overpayment, strictly the newest money first (the excess came in last).
   */
  order: 'PAYPAL_FIRST' | 'NEWEST_FIRST' = 'PAYPAL_FIRST',
  /** Only this payment pays (an already existing PayPal refund belongs to exactly one capture). */
  onlyPaymentId?: string,
): Promise<RefundPlan[]> {
  const received = await tx
    .select({
      payment: payments,
      iban: bankTransactions.counterpartyIban,
      name: bankTransactions.counterpartyName,
    })
    .from(payments)
    .leftJoin(bankTransactions, eq(bankTransactions.id, payments.bankTransactionId))
    .where(
      and(
        eq(payments.orderId, orderId),
        inArray(payments.status, ['CAPTURED', 'PARTIALLY_REFUNDED']),
      ),
    )
    .orderBy(desc(payments.capturedAt), desc(payments.createdAt));
  const reserved = await tx
    .select({ paymentId: refunds.paymentId, total: sql<number>`SUM(${refunds.amount})::int` })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, orderId),
        inArray(refunds.status, [...MONEY_RESERVING_REFUND_STATUSES]),
      ),
    )
    .groupBy(refunds.paymentId);
  const reservedBy = new Map(reserved.map((r) => [r.paymentId, r.total]));

  const usable = received
    .filter((r) => r.payment.method !== 'COMPLIMENTARY' && r.payment.amount > 0)
    .map((r) => ({
      ...r,
      automatic: r.payment.method === 'PAYPAL' && Boolean(r.payment.providerCaptureId),
      available: r.payment.amount - (reservedBy.get(r.payment.id) ?? 0),
    }))
    .filter((r) => r.available > 0 && (!onlyPaymentId || r.payment.id === onlyPaymentId))
    // Stable sort keeps newest first.
    .sort((a, b) => (order === 'PAYPAL_FIRST' ? Number(b.automatic) - Number(a.automatic) : 0));

  const queue = components.map((c) => ({ ...c, left: c.amount }));
  const plans: RefundPlan[] = [];
  for (const source of usable) {
    let capacity = source.available;
    const allocations: Component[] = [];
    for (const component of queue) {
      if (capacity === 0) break;
      if (component.left === 0) continue;
      const take = Math.min(capacity, component.left);
      component.left -= take;
      capacity -= take;
      allocations.push({ kind: component.kind, id: component.id, amount: take });
    }
    const amount = allocations.reduce((sum, a) => sum + a.amount, 0);
    if (amount === 0) continue;
    plans.push({
      payment: source.payment,
      kind: source.automatic ? 'AUTOMATIC' : 'MANUAL',
      amount,
      payerIban: source.automatic ? null : source.iban,
      payerName: source.automatic ? null : source.name,
      allocations,
    });
  }
  return plans;
}

// ─── Credit note ────────────────────────────────────────────────────────────

async function issueCreditNote(
  ctx: CoreContext,
  tx: Transaction,
  params: {
    orderId: string;
    itemIds: Set<string>;
    fees: Map<string, FeeRefund>;
    refundIds: string[];
  },
): Promise<{ id: string; number: string } | null> {
  const active = await findActiveInvoice(tx, params.orderId);
  if (!active) return null; // invoicing disabled: the refund still happens
  const [original] = await tx.select().from(invoices).where(eq(invoices.id, active.id));
  if (!original) return null;
  const originalLines = await tx
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, original.id))
    .orderBy(asc(invoiceLines.position));

  const earlier = await creditedFeeAmounts(tx, params.orderId, [...params.fees.keys()]);
  const lines: (typeof invoiceLines.$inferInsert)[] = [];
  for (const line of originalLines) {
    if (line.orderItemId && params.itemIds.has(line.orderItemId)) {
      lines.push({
        invoiceId: '',
        position: lines.length + 1,
        description: line.description,
        serviceDate: line.serviceDate,
        quantity: -line.quantity,
        unitPriceGross: line.unitPriceGross,
        taxRateBasisPoints: line.taxRateBasisPoints,
        totalNet: -line.totalNet,
        totalTax: -line.totalTax,
        totalGross: -line.totalGross,
        orderItemId: line.orderItemId,
        orderFeeId: null,
      });
    } else if (line.orderFeeId && params.fees.has(line.orderFeeId)) {
      const fee = params.fees.get(line.orderFeeId)!;
      // The credit that completes the line takes what earlier credit notes left (net and tax
      // add up to the original line exactly); partial credits are split by the rate.
      const before = earlier.get(line.orderFeeId) ?? { gross: 0, net: 0, tax: 0 };
      const { net, tax } =
        fee.amount === line.totalGross - before.gross
          ? { net: line.totalNet - before.net, tax: line.totalTax - before.tax }
          : splitGross(fee.amount, line.taxRateBasisPoints);
      lines.push({
        invoiceId: '',
        position: lines.length + 1,
        description: line.description,
        serviceDate: line.serviceDate,
        quantity: -Math.max(1, Math.min(fee.quantity, line.quantity)),
        unitPriceGross: line.unitPriceGross,
        taxRateBasisPoints: line.taxRateBasisPoints,
        totalNet: -net,
        totalTax: -tax,
        totalGross: -fee.amount,
        orderItemId: null,
        orderFeeId: line.orderFeeId,
      });
    }
  }
  if (lines.length === 0) return null;

  const byRate = new Map<number, TaxBreakdownEntry>();
  for (const line of lines) {
    const entry = byRate.get(line.taxRateBasisPoints) ?? {
      rateBasisPoints: line.taxRateBasisPoints,
      net: 0,
      tax: 0,
      gross: 0,
    };
    entry.net += line.totalNet;
    entry.tax += line.totalTax;
    entry.gross += line.totalGross;
    byRate.set(line.taxRateBasisPoints, entry);
  }
  const notesByRate = new Map(original.taxBreakdown.map((e) => [e.rateBasisPoints, e.note]));
  const taxBreakdown = [...byRate.values()]
    .sort((a, b) => b.rateBasisPoints - a.rateBasisPoints)
    .map((entry) => {
      const note = notesByRate.get(entry.rateBasisPoints);
      return note ? { ...entry, note } : entry;
    });
  const sum = (pick: (l: (typeof lines)[number]) => number) =>
    lines.reduce((s, l) => s + pick(l), 0);

  const [invoicing, general] = await Promise.all([
    getSetting(ctx, 'invoicing'),
    getSetting(ctx, 'general'),
  ]);
  const issuedAt = new Date();
  const number = await nextNumber(
    tx,
    'credit_note',
    invoicing.creditNoteNumberPattern,
    issuedAt,
    general.defaultTimeZone,
  );
  const legalNotes =
    [...new Set(taxBreakdown.flatMap((e) => (e.note ? [e.note] : [])))].join('\n') || null;
  const [creditNote] = await tx
    .insert(invoices)
    .values({
      orderId: params.orderId,
      type: 'CREDIT_NOTE',
      invoiceNumber: number,
      correctsInvoiceId: original.id,
      issuedAt,
      seller: original.seller,
      buyer: original.buyer,
      currency: original.currency,
      totalNet: sum((l) => l.totalNet),
      totalTax: sum((l) => l.totalTax),
      totalGross: sum((l) => l.totalGross),
      taxBreakdown,
      legalNotes,
    })
    .returning({ id: invoices.id });
  await tx.insert(invoiceLines).values(lines.map((l) => ({ ...l, invoiceId: creditNote!.id })));
  if (params.refundIds.length > 0) {
    await tx
      .update(refunds)
      .set({ creditNoteId: creditNote!.id })
      .where(inArray(refunds.id, params.refundIds));
  }
  await tx.insert(orderHistory).values({
    orderId: params.orderId,
    type: 'credit_note_issued',
    actorType: 'SYSTEM',
    data: {
      invoiceId: creditNote!.id,
      invoiceNumber: number,
      totalGross: sum((l) => l.totalGross),
    },
  });
  return { id: creditNote!.id, number };
}

/**
 * Credit note that negates the whole active invoice (bank allocation reversed: the sale is
 * undone until the order is paid again). Null when the order has no active invoice.
 */
export async function issueFullCreditNote(
  ctx: CoreContext,
  tx: Transaction,
  orderId: string,
): Promise<{ id: string; number: string } | null> {
  const active = await findActiveInvoice(tx, orderId);
  if (!active) return null;
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, active.id));
  const itemIds = new Set(lines.flatMap((l) => (l.orderItemId ? [l.orderItemId] : [])));
  const fees = new Map<string, FeeRefund>(
    lines.flatMap((l) =>
      l.orderFeeId && l.totalGross > 0
        ? [[l.orderFeeId, { amount: l.totalGross, quantity: l.quantity, completes: true }] as const]
        : [],
    ),
  );
  const creditNote = await issueCreditNote(ctx, tx, { orderId, itemIds, fees, refundIds: [] });
  if (creditNote) {
    await tx
      .insert(invoiceSupersessions)
      .values({ invoiceId: active.id, creditNoteId: creditNote.id });
  }
  return creditNote;
}

// ─── PayPal refund execution ────────────────────────────────────────────────

/** Retries of the refund job: 30 s, 1, 2, 4, 8 min; the sweeper re-queues what is still PENDING later. */
export const REFUND_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 30_000 },
} as const;

export async function enqueueRefund(
  ctx: CoreContext,
  refundId: string,
  jobId = `refund-${refundId}`,
): Promise<void> {
  if (!ctx.jobs) return;
  try {
    await ctx.jobs.add(
      QUEUE_NAMES.refunds,
      'execute-refund',
      { refundId },
      { jobId, ...REFUND_JOB_OPTIONS },
    );
  } catch (err) {
    // The refund row is stored; the sweeper picks it up.
    coreLog.error({ err }, '[refunds] refund job could not be queued (sweeper retries)');
  }
}

export type RefundExecution = 'SUCCEEDED' | 'PENDING' | 'FAILED' | 'SKIPPED';

/**
 * Executes one automatic (PayPal) refund. Idempotent: settled rows are skipped, the PayPal
 * request id is per refund row so a repeated call returns the original PayPal refund. Transient
 * errors (network, 429, 5xx) are thrown for the BullMQ retry; permanent ones mark the row FAILED
 * (shown as to-do, `retryRefund` / manual completion).
 */
export async function processPaypalRefund(
  ctx: CoreContext,
  refundId: string,
): Promise<RefundExecution> {
  const [row] = await ctx.db
    .select({
      refund: refunds,
      captureId: payments.providerCaptureId,
      orderNumber: orders.orderNumber,
    })
    .from(refunds)
    .leftJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(eq(refunds.id, refundId));
  if (!row) throw new DomainError('REFUND_NOT_FOUND', 'Refund not found', 404);
  const { refund } = row;
  if (refund.status !== 'PENDING' || refund.kind !== 'AUTOMATIC') return 'SKIPPED';
  // After a backup restore the local rows can be out of sync with PayPal: nothing is sent or
  // polled until `reconcileRefundsAfterRestore` has settled them (the job is retried later).
  if (await isRefundReconcilePending(ctx)) {
    throw new DomainError(
      'REFUNDS_RECONCILING',
      'Refunds are being reconciled with PayPal after a restore',
      503,
    );
  }
  // PayPal shows refunds we do not know about: nothing is sent until an admin resolved the review.
  if (await hasOpenRefundReview(ctx.db, refund.orderId)) {
    throw new DomainError(
      'REFUNDS_REVIEW_OPEN',
      'PayPal refunds of this order are on hold: resolve the refund review first',
      503,
    );
  }
  if (!row.captureId) {
    await failRefund(ctx, refund.id, 'The payment has no PayPal capture to refund');
    return 'FAILED';
  }

  let result;
  try {
    result = refund.providerRefundId
      ? await getPayPalRefund(ctx, refund.providerRefundId)
      : await createPayPalRefund(ctx, {
          requestId: `tix-refund-${refund.id}-${refund.attempt}`,
          customId: refund.id,
          captureId: row.captureId,
          amountCents: refund.amount,
          currency: refund.currency,
          note: `Order ${row.orderNumber}`,
        });
  } catch (err) {
    if (isTransientPayPalError(err)) throw err;
    await failRefund(ctx, refund.id, err instanceof Error ? err.message : String(err));
    return 'FAILED';
  }

  if (result.status === 'COMPLETED') {
    await withTransaction(ctx.db, (tx) =>
      markRefundSucceeded(tx, refund.id, {
        providerRefundId: result.id,
        actor: { type: 'SYSTEM' },
      }),
    );
    return 'SUCCEEDED';
  }
  if (result.status === 'PENDING') {
    // PayPal completes it later (webhook PAYMENT.CAPTURE.REFUNDED or the sweeper's status poll).
    await ctx.db
      .update(refunds)
      .set({ providerRefundId: result.id, updatedAt: new Date() })
      .where(and(eq(refunds.id, refund.id), eq(refunds.status, 'PENDING')));
    return 'PENDING';
  }
  await failRefund(
    ctx,
    refund.id,
    `PayPal refund ${result.status}${result.statusReason ? `: ${result.statusReason}` : ''}`,
    result.id,
  );
  return 'FAILED';
}

export async function failRefund(
  ctx: CoreContext,
  refundId: string,
  message: string,
  providerRefundId?: string,
): Promise<void> {
  const [row] = await ctx.db
    .update(refunds)
    .set({
      status: 'FAILED',
      failureMessage: message.slice(0, 1000),
      ...(providerRefundId ? { providerRefundId } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, 'PENDING')))
    .returning({ orderId: refunds.orderId });
  if (row) {
    await ctx.db.insert(orderHistory).values({
      orderId: row.orderId,
      type: 'refund_failed',
      actorType: 'SYSTEM',
      data: { refundId, message },
    });
  }
}

/** FAILED automatic refund → PENDING again and queued (admin action). */
export async function retryRefund(
  ctx: CoreContext,
  refundId: string,
  userId: string,
): Promise<void> {
  const [row] = await ctx.db
    .update(refunds)
    .set({
      status: 'PENDING',
      failureMessage: null,
      // The provider declined the previous attempt (a FAILED row only exists after a definite
      // answer – transient errors keep the row PENDING): a new request id and a fresh PayPal
      // refund; the old, failed provider refund id is dropped so it is not polled again.
      attempt: sql`${refunds.attempt} + 1`,
      providerRefundId: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(refunds.id, refundId), eq(refunds.status, 'FAILED'), eq(refunds.kind, 'AUTOMATIC')),
    )
    .returning({ orderId: refunds.orderId });
  if (!row) {
    throw new DomainError(
      'REFUND_NOT_RETRYABLE',
      'Only failed automatic refunds can be retried',
      409,
    );
  }
  await ctx.db.insert(orderHistory).values({
    orderId: row.orderId,
    type: 'refund_retried',
    actorType: 'ADMIN',
    actorUserId: userId,
    data: { refundId },
  });
  // Fresh job id: finished jobs are retained and would swallow a re-add with the same id.
  await enqueueRefund(ctx, refundId, `refund-${refundId}-${Date.now().toString(36)}`);
}

/**
 * Sweeper: automatic refunds that are still PENDING after `olderThanMinutes` (job lost, Redis
 * outage, PayPal answered PENDING) are queued again. Safe to repeat – execution is idempotent.
 */
export async function requeueStaleRefunds(
  ctx: CoreContext,
  options: { olderThanMinutes?: number; limit?: number } = {},
): Promise<number> {
  // While the post-restore reconciliation is pending nothing is re-queued (the jobs would only wait).
  if (await isRefundReconcilePending(ctx)) return 0;
  const stale = await ctx.db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.status, 'PENDING'),
        eq(refunds.kind, 'AUTOMATIC'),
        lt(refunds.updatedAt, new Date(Date.now() - (options.olderThanMinutes ?? 20) * 60_000)),
      ),
    )
    .orderBy(asc(refunds.createdAt))
    .limit(options.limit ?? 100);
  for (const { id } of stale) {
    // Touch the row so the next sweep leaves it alone while the new job is in flight.
    await ctx.db.update(refunds).set({ updatedAt: new Date() }).where(eq(refunds.id, id));
    await enqueueRefund(ctx, id, `refund-${id}-${Date.now().toString(36)}`);
  }
  return stale.length;
}

// ─── Record an existing PayPal refund ───────────────────────────────────────

export interface RecordExistingPayPalRefundParams extends Omit<
  CancelPaidOrderParams,
  'existingPaypalRefund' | 'expectedVersion'
> {
  /** PayPal refund id (from the review finding). */
  providerRefundId: string;
}

export interface ExistingPayPalRefund {
  providerRefundId: string;
  paymentId: string;
  amount: number;
}

/**
 * Fetches the refund live from PayPal and checks that it can be recorded for this order: COMPLETED,
 * belongs to a capture of the order, same currency, not recorded yet.
 */
async function verifyExistingPayPalRefund(
  ctx: CoreContext,
  orderId: string,
  providerRefundId: string,
): Promise<ExistingPayPalRefund> {
  const details = await getPayPalRefundDetails(ctx, providerRefundId);
  if (details.status !== 'COMPLETED') {
    throw new DomainError(
      'PAYPAL_REFUND_NOT_COMPLETED',
      'The PayPal refund is not completed',
      409,
      { status: details.status },
    );
  }
  const [payment] = details.captureId
    ? await ctx.db
        .select()
        .from(payments)
        .where(
          and(eq(payments.orderId, orderId), eq(payments.providerCaptureId, details.captureId)),
        )
    : [];
  if (!payment || payment.currency !== details.currency || details.amountCents <= 0) {
    throw new DomainError(
      'PAYPAL_REFUND_MISMATCH',
      'The PayPal refund does not belong to a payment of this order',
      409,
    );
  }
  const [known] = await ctx.db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      or(
        eq(refunds.providerRefundId, details.id),
        details.customId && /^[0-9a-f-]{36}$/i.test(details.customId)
          ? eq(refunds.id, details.customId)
          : undefined,
      ),
    )
    .limit(1);
  if (known) {
    throw new DomainError(
      'PAYPAL_REFUND_ALREADY_RECORDED',
      'This PayPal refund belongs to a refund that is already recorded',
      409,
    );
  }
  return { providerRefundId: details.id, paymentId: payment.id, amount: details.amountCents };
}

/**
 * Review action: the money already went back at PayPal (lost window, PayPal dashboard). Cancels
 * the chosen tickets like `cancelPaidOrder` (credit note, seats released) but books the refund as
 * SUCCEEDED with the PayPal refund id and sends nothing. The refund is verified live at PayPal
 * (see `verifyExistingPayPalRefund`); the plan is pinned to the capture it belongs to, and the
 * selected tickets (+ fees) must add up to exactly its amount.
 */
export async function recordExistingPayPalRefund(
  ctx: CoreContext,
  params: RecordExistingPayPalRefundParams,
): Promise<CancelPaidOrderResult> {
  const existing = await verifyExistingPayPalRefund(ctx, params.orderId, params.providerRefundId);
  return cancelPaidOrder(ctx, { ...params, existingPaypalRefund: existing });
}

/**
 * Review action for refunds that paid back an overpayment (no tickets involved): books the existing
 * PayPal refund as an overpayment refund (SUCCEEDED, no credit note) without sending anything.
 */
export async function recordExistingPayPalOverpaymentRefund(
  ctx: CoreContext,
  params: {
    orderId: string;
    userId: string;
    providerRefundId: string;
    reason?: string | null;
    inTransaction?: (tx: Transaction, result: RefundOverpaymentResult) => Promise<void>;
  },
): Promise<RefundOverpaymentResult> {
  const existing = await verifyExistingPayPalRefund(ctx, params.orderId, params.providerRefundId);
  return refundOverpayment(ctx, {
    orderId: params.orderId,
    userId: params.userId,
    reason: params.reason,
    existingPaypalRefund: existing,
    inTransaction: params.inTransaction,
  });
}

// ─── Overpayment refund ─────────────────────────────────────────────────────

export interface RefundOverpaymentResult {
  batchId: string;
  amount: number;
  refunds: { id: string; kind: 'AUTOMATIC' | 'MANUAL'; amount: number; method: PaymentMethod }[];
}

/**
 * Pays back the overpayment of a PAID order (net money above the order total): the excess is
 * refunded from the newest payments – PayPal captures automatically, everything else becomes a
 * MANUAL "Erstattung offen" to-do (one batch, no credit note: the invoice is not affected).
 * Credit already reserved by an open tariff change is not refunded.
 */
export async function refundOverpayment(
  ctx: CoreContext,
  params: {
    orderId: string;
    userId: string;
    /** The amount the admin saw: refused when the refundable excess changed meanwhile. */
    expectedAmount?: number;
    reason?: string | null;
    /** The money already went back at PayPal (verified by the caller): booked as SUCCEEDED, nothing is sent. */
    existingPaypalRefund?: ExistingPayPalRefund;
    /** Runs inside the business transaction at the end (e.g. the audit entry). */
    inTransaction?: (tx: Transaction, result: RefundOverpaymentResult) => Promise<void>;
  },
): Promise<RefundOverpaymentResult> {
  const outcome = await withTransaction(ctx.db, async (tx) => {
    await lockOrderTickets(tx, params.orderId);
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (!OVERPAYMENT_ORDER_STATUSES.includes(order.status)) {
      throw new DomainError('ORDER_NOT_REFUNDABLE', 'Only paid orders can be refunded here', 409, {
        status: order.status,
      });
    }
    const open = await findOpenAdjustment(tx, order.id);
    const { credit } = await orderCredit(tx, order);
    const refundable = credit - (open?.creditApplied ?? 0);
    if (refundable <= 0) {
      throw new DomainError('NO_OVERPAYMENT', 'The order has no overpayment to refund', 409);
    }
    const existing = params.existingPaypalRefund;
    if (existing ? refundable < existing.amount : refundable !== params.expectedAmount) {
      throw new DomainError(
        'OVERPAYMENT_CHANGED',
        'The overpayment changed in the meantime – reload the page',
        409,
        { refundable },
      );
    }
    const plans = await planRefunds(
      tx,
      order.id,
      [{ kind: 'item', id: order.id, amount: existing ? existing.amount : refundable }],
      'NEWEST_FIRST',
      existing?.paymentId,
    );
    const automaticPlans = plans.filter((plan) => plan.kind === 'AUTOMATIC');
    if (existing) {
      if (
        plans.length !== 1 ||
        automaticPlans.length !== 1 ||
        plans[0]!.payment.id !== existing.paymentId ||
        plans[0]!.amount !== existing.amount
      ) {
        throw new DomainError(
          'REFUND_EXISTING_MISMATCH',
          'The PayPal refund does not match the refundable overpayment of its payment',
          409,
          { paypalAmount: existing.amount, plannedAmounts: plans.map((plan) => plan.amount) },
        );
      }
    } else if (automaticPlans.length > 0 && (await hasOpenRefundReview(tx, order.id))) {
      throw new DomainError(
        'REFUND_REVIEW_OPEN',
        'PayPal refunds of this order are on hold: resolve the refund review first',
        409,
      );
    }
    const batchId = randomUUID();
    const rows: RefundOverpaymentResult['refunds'] = [];
    let recordedRefundId: string | null = null;
    for (const plan of plans) {
      const [row] = await tx
        .insert(refunds)
        .values({
          orderId: order.id,
          batchId,
          overpayment: true,
          paymentId: plan.payment.id,
          method: plan.payment.method,
          kind: plan.kind,
          status: 'PENDING',
          amount: plan.amount,
          currency: order.currency,
          reason: params.reason?.trim() || OVERPAYMENT_REASON,
          payerIban: plan.payerIban,
          payerName: plan.payerName,
          requestedByUserId: params.userId,
          ...(existing ? { providerRefundId: existing.providerRefundId } : {}),
        })
        .returning({ id: refunds.id });
      if (existing) {
        await markRefundSucceeded(tx, row!.id, {
          providerRefundId: existing.providerRefundId,
          actor: { type: 'ADMIN', userId: params.userId },
          note: 'Existing PayPal refund recorded',
        });
        recordedRefundId = row!.id;
      }
      rows.push({ id: row!.id, kind: plan.kind, amount: plan.amount, method: plan.payment.method });
    }
    const amount = rows.reduce((sum, r) => sum + r.amount, 0);
    if (amount === 0) {
      throw new DomainError('NO_OVERPAYMENT', 'The order has no overpayment to refund', 409);
    }
    await tx
      .update(orders)
      .set({ version: sql`${orders.version} + 1` })
      .where(eq(orders.id, order.id));
    await tx.insert(orderHistory).values({
      orderId: order.id,
      type: 'overpayment_refund_requested',
      actorType: 'ADMIN',
      actorUserId: params.userId,
      data: { batchId, amount, refundIds: rows.map((r) => r.id) },
    });
    if (existing) {
      await resolveReviewIfOnly(tx, order.id, existing.providerRefundId, params.userId);
    }
    const result = { batchId, amount, refunds: rows };
    await params.inTransaction?.(tx, result);
    return { result, recordedRefundId };
  });
  for (const refund of outcome.result.refunds) {
    if (refund.kind === 'AUTOMATIC' && refund.id !== outcome.recordedRefundId) {
      await enqueueRefund(ctx, refund.id);
    }
  }
  return outcome.result;
}

/** Default reason text of an overpayment refund (shown in the refund lists). */
export const OVERPAYMENT_REASON = 'Overpayment';

/** Order states an overpayment can be refunded in (also after whole / partial cancellations). */
const OVERPAYMENT_ORDER_STATUSES: readonly OrderStatus[] = [
  'PAID',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];

// ─── Manual refunds ("Erstattung offen") ────────────────────────────────────

/**
 * Finance transferred the money by hand: open manual refunds (and failed automatic ones, e.g.
 * paid back outside PayPal) become SUCCEEDED. Idempotent – a second click returns `false`.
 */
export async function completeManualRefund(
  ctx: CoreContext,
  params: { refundId: string; userId: string; note?: string | null },
): Promise<boolean> {
  return withTransaction(ctx.db, async (tx) => {
    // Lock order → refund (same order as cancelPaidOrder / markRefundSucceeded).
    const [owner] = await tx
      .select({ orderId: refunds.orderId })
      .from(refunds)
      .where(eq(refunds.id, params.refundId));
    if (!owner) throw new DomainError('REFUND_NOT_FOUND', 'Refund not found', 404);
    await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, owner.orderId))
      .for('update');
    const [refund] = await tx
      .select({ status: refunds.status, kind: refunds.kind, orderId: refunds.orderId })
      .from(refunds)
      .where(eq(refunds.id, params.refundId))
      .for('update');
    if (!refund) throw new DomainError('REFUND_NOT_FOUND', 'Refund not found', 404);
    if (refund.status === 'SUCCEEDED') return false;
    if (refund.kind === 'AUTOMATIC' && refund.status !== 'FAILED') {
      throw new DomainError(
        'REFUND_NOT_MANUAL',
        'This refund is executed automatically by the payment provider',
        409,
      );
    }
    return markRefundSucceeded(tx, params.refundId, {
      actor: { type: 'ADMIN', userId: params.userId },
      note: params.note?.trim() || null,
    });
  });
}

/**
 * "Mark as refunded" for a whole batch: every open MANUAL row of the batch (one transfer per
 * payer, but one click) becomes SUCCEEDED in ONE transaction, each with its own history entry.
 * Returns the ids that were completed (empty = nothing was open, e.g. a second click).
 */
export async function completeRefundBatch(
  ctx: CoreContext,
  params: { batchId: string; userId: string; note?: string | null },
): Promise<string[]> {
  return withTransaction(ctx.db, async (tx) => {
    const [owner] = await tx
      .select({ orderId: refunds.orderId })
      .from(refunds)
      .where(eq(refunds.batchId, params.batchId))
      .limit(1);
    if (!owner) throw new DomainError('REFUND_NOT_FOUND', 'Refund not found', 404);
    // Same lock order as completeManualRefund: order → refunds.
    await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, owner.orderId))
      .for('update');
    const open = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          eq(refunds.batchId, params.batchId),
          eq(refunds.kind, 'MANUAL'),
          inArray(refunds.status, ['PENDING', 'FAILED']),
        ),
      )
      .orderBy(asc(refunds.createdAt), asc(refunds.id))
      .for('update');
    const completed: string[] = [];
    for (const { id } of open) {
      const done = await markRefundSucceeded(tx, id, {
        actor: { type: 'ADMIN', userId: params.userId },
        note: params.note?.trim() || null,
      });
      if (done) completed.push(id);
    }
    return completed;
  });
}

/** Retries the failed automatic (PayPal) rows of a batch. Returns the retried refund ids. */
export async function retryRefundBatch(
  ctx: CoreContext,
  params: { batchId: string; userId: string },
): Promise<string[]> {
  const failed = await ctx.db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.batchId, params.batchId),
        eq(refunds.kind, 'AUTOMATIC'),
        eq(refunds.status, 'FAILED'),
      ),
    )
    .orderBy(asc(refunds.createdAt), asc(refunds.id));
  if (failed.length === 0) {
    throw new DomainError(
      'REFUND_NOT_RETRYABLE',
      'Only failed automatic refunds can be retried',
      409,
    );
  }
  const retried: string[] = [];
  for (const { id } of failed) {
    try {
      await retryRefund(ctx, id, params.userId);
      retried.push(id);
    } catch (err) {
      // Settled or retried by someone else in the meantime: nothing to do for this row.
      if (!(err instanceof DomainError) || err.code !== 'REFUND_NOT_RETRYABLE') throw err;
    }
  }
  return retried;
}

/** Internal ops threshold: an automatic refund pending this long is shown as a to-do. */
export const STUCK_REFUND_AFTER_MS = 24 * 60 * 60 * 1000;

const openFilter = () =>
  and(
    inArray(refunds.status, ['PENDING', 'FAILED']),
    // Manual refunds and failed automatic ones are to-dos; automatic ones merely in flight
    // only once they are stuck.
    or(
      eq(refunds.kind, 'MANUAL'),
      eq(refunds.status, 'FAILED'),
      lt(refunds.createdAt, new Date(Date.now() - STUCK_REFUND_AFTER_MS)),
    ),
  );

/** One refund row (money back to one payment). */
export interface RefundRowView {
  id: string;
  kind: 'AUTOMATIC' | 'MANUAL';
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  method: PaymentMethod;
  amount: number;
  payerIban: string | null;
  payerName: string | null;
  failureMessage: string | null;
  note: string | null;
  /** Automatic refund still PENDING after `STUCK_REFUND_AFTER_MS`. */
  stuck: boolean;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * All refund rows of one cancellation / overpayment refund: ONE amount for the admin (and one
 * credit note). PayPal needs a row per capture and every payment has its own cap, so the rows
 * stay separate in the database and are only presented together.
 */
export interface RefundBatchView {
  batchId: string;
  currency: string;
  /** Everything paid back (or to be paid back) with this cancellation. */
  totalAmount: number;
  /** Part that is not settled yet (PENDING / FAILED rows). */
  openAmount: number;
  /** FAILED if any row failed, else PENDING while something is open, else SUCCEEDED. */
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  stuck: boolean;
  overpayment: boolean;
  reason: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  createdAt: Date;
  completedAt: Date | null;
  rows: RefundRowView[];
  /** Open MANUAL rows, one entry per payer (the money goes to the same account in one transfer). */
  transfers: { payerIban: string | null; payerName: string | null; amount: number }[];
  /** Open MANUAL rows exist ("Als erstattet markieren"). */
  canComplete: boolean;
  /** Failed automatic rows exist (retry). */
  canRetry: boolean;
}

export interface OpenRefundBatch extends RefundBatchView {
  orderId: string;
  orderNumber: string;
  customerName: string;
  email: string | null;
}

export type OrderRefundRow = RefundRowView & {
  batchId: string;
  reason: string | null;
  overpayment: boolean;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
};

const normalizeIban = (iban: string | null) => (iban ?? '').replace(/\s+/g, '').toUpperCase();

function buildBatch(rows: OrderRefundRow[], currency: string): RefundBatchView {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const first = sorted[0]!;
  const open = sorted.filter((r) => r.status !== 'SUCCEEDED');
  const openManual = open.filter((r) => r.kind === 'MANUAL');
  const transfers = new Map<string, RefundBatchView['transfers'][number]>();
  for (const r of openManual) {
    // Same payer account (or, without IBAN, same name) = one transfer.
    const key = normalizeIban(r.payerIban) || `name:${(r.payerName ?? '').trim().toLowerCase()}`;
    const entry = transfers.get(key);
    if (entry) entry.amount += r.amount;
    else transfers.set(key, { payerIban: r.payerIban, payerName: r.payerName, amount: r.amount });
  }
  const completedAts = sorted.map((r) => r.completedAt);
  return {
    batchId: first.batchId,
    currency,
    totalAmount: sorted.reduce((sum, r) => sum + r.amount, 0),
    openAmount: open.reduce((sum, r) => sum + r.amount, 0),
    status: sorted.some((r) => r.status === 'FAILED')
      ? 'FAILED'
      : open.length > 0
        ? 'PENDING'
        : 'SUCCEEDED',
    stuck: sorted.some((r) => r.stuck),
    // Only a batch consisting of overpayment rows is an overpayment refund; a cancellation that
    // also pays back an excess is a normal batch (its credit note belongs to the cancellation).
    overpayment: sorted.every((r) => r.overpayment),
    reason:
      (sorted.find((r) => r.reason && !r.overpayment) ?? sorted.find((r) => r.reason))?.reason ??
      null,
    creditNoteId: sorted.find((r) => r.creditNoteId)?.creditNoteId ?? null,
    creditNoteNumber: sorted.find((r) => r.creditNoteId)?.creditNoteNumber ?? null,
    createdAt: first.createdAt,
    completedAt:
      open.length === 0 && completedAts.every(Boolean)
        ? new Date(Math.max(...completedAts.map((d) => d!.getTime())))
        : null,
    rows: sorted.map(
      ({
        batchId: _b,
        reason: _r,
        overpayment: _o,
        creditNoteId: _c,
        creditNoteNumber: _n,
        ...row
      }) => row,
    ),
    transfers: [...transfers.values()],
    canComplete: openManual.length > 0,
    canRetry: open.some((r) => r.kind === 'AUTOMATIC' && r.status === 'FAILED'),
  };
}

type RefundQueryRow = Awaited<ReturnType<typeof selectRefundRows>>[number];

function selectRefundRows(db: Pick<CoreContext, 'db'>['db'], where: ReturnType<typeof and>) {
  return db
    .select({
      id: refunds.id,
      batchId: refunds.batchId,
      orderId: refunds.orderId,
      orderNumber: orders.orderNumber,
      firstName: orders.firstName,
      lastName: orders.lastName,
      email: orders.email,
      kind: refunds.kind,
      status: refunds.status,
      method: refunds.method,
      amount: refunds.amount,
      currency: refunds.currency,
      reason: refunds.reason,
      overpayment: refunds.overpayment,
      payerIban: refunds.payerIban,
      payerName: refunds.payerName,
      failureMessage: refunds.failureMessage,
      note: refunds.note,
      creditNoteId: refunds.creditNoteId,
      creditNoteNumber: invoices.invoiceNumber,
      createdAt: refunds.createdAt,
      completedAt: refunds.completedAt,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .leftJoin(invoices, eq(invoices.id, refunds.creditNoteId))
    .where(where)
    .orderBy(asc(refunds.createdAt));
}

function groupBatches(rows: RefundQueryRow[]): (RefundBatchView & { source: RefundQueryRow })[] {
  const stuckBefore = Date.now() - STUCK_REFUND_AFTER_MS;
  const byBatch = new Map<string, OrderRefundRow[]>();
  const sources = new Map<string, RefundQueryRow>();
  for (const r of rows) {
    const row: OrderRefundRow = {
      id: r.id,
      batchId: r.batchId,
      kind: r.kind,
      status: r.status,
      method: r.method,
      amount: r.amount,
      reason: r.reason,
      overpayment: r.overpayment,
      payerIban: r.payerIban,
      payerName: r.payerName,
      failureMessage: r.failureMessage,
      note: r.note,
      creditNoteId: r.creditNoteId,
      creditNoteNumber: r.creditNoteNumber,
      stuck:
        r.kind === 'AUTOMATIC' && r.status === 'PENDING' && r.createdAt.getTime() < stuckBefore,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
    byBatch.set(r.batchId, [...(byBatch.get(r.batchId) ?? []), row]);
    if (!sources.has(r.batchId)) sources.set(r.batchId, r);
  }
  return [...byBatch].map(([batchId, batchRows]) => ({
    ...buildBatch(batchRows, sources.get(batchId)!.currency),
    source: sources.get(batchId)!,
  }));
}

/**
 * To-do list: one entry per cancellation (batch) that still has a manual refund waiting for a
 * transfer or a failed / stuck automatic refund, oldest first.
 */
export async function listOpenRefunds(ctx: Pick<CoreContext, 'db'>): Promise<OpenRefundBatch[]> {
  const rows = await selectRefundRows(
    ctx.db,
    inArray(
      refunds.batchId,
      ctx.db.select({ batchId: refunds.batchId }).from(refunds).where(openFilter()),
    ),
  );
  return groupBatches(rows)
    .map(({ source, ...batch }) => ({
      ...batch,
      orderId: source.orderId,
      orderNumber: source.orderNumber,
      customerName: `${source.firstName} ${source.lastName}`.trim(),
      email: source.email,
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Number of open refund to-dos = batches with an open row (navigation badge). */
export async function countOpenRefunds(ctx: Pick<CoreContext, 'db'>): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(distinct ${refunds.batchId})::int` })
    .from(refunds)
    .where(openFilter());
  return row?.n ?? 0;
}

/** All refund rows of one order (admin order page), newest first. */
export async function listOrderRefunds(
  ctx: Pick<CoreContext, 'db'>,
  orderId: string,
): Promise<OrderRefundRow[]> {
  const rows = await selectRefundRows(ctx.db, eq(refunds.orderId, orderId));
  const stuckBefore = Date.now() - STUCK_REFUND_AFTER_MS;
  return rows
    .map((r) => ({
      id: r.id,
      batchId: r.batchId,
      kind: r.kind,
      status: r.status,
      method: r.method,
      amount: r.amount,
      reason: r.reason,
      overpayment: r.overpayment,
      payerIban: r.payerIban,
      payerName: r.payerName,
      failureMessage: r.failureMessage,
      note: r.note,
      creditNoteId: r.creditNoteId,
      creditNoteNumber: r.creditNoteNumber,
      stuck:
        r.kind === 'AUTOMATIC' && r.status === 'PENDING' && r.createdAt.getTime() < stuckBefore,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    }))
    .reverse();
}

/** The refunds of one order grouped per cancellation / overpayment refund, newest first. */
export async function listOrderRefundBatches(
  ctx: Pick<CoreContext, 'db'>,
  orderId: string,
): Promise<RefundBatchView[]> {
  const rows = await selectRefundRows(ctx.db, eq(refunds.orderId, orderId));
  return groupBatches(rows)
    .map(({ source: _source, ...batch }) => batch)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
