import {
  bankTransactionAllocations,
  bankTransactions,
  emailMessages,
  events,
  orderAdjustments,
  orderHistory,
  orderItems,
  orders,
  payments,
  refunds,
  tickets,
  withTransaction,
  type Transaction,
} from '@tix/db';
import type { OrderStatus } from '@tix/shared';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { withMutex } from '../banking/runs';
import { DomainError, type CoreContext } from '../context';
import { enqueueInvoiceRender } from '../invoices';
import { getSetting } from '../settings';
import { lockOrderTickets, voidTicketsForItems } from '../tickets/issue';
import { findOpenAdjustment } from './adjustment-state';
import { orderCredit } from './credit';
import { mirrorSeats } from './fulfillment';
import { ALLOCATION_REVERSED_HISTORY } from './paid-cycle';
import { computeBankTransferTerms } from './payment-terms';
import { issueFullCreditNote } from './refunds';

/**
 * Undo a bank-transaction allocation (a transfer matched to the wrong order).
 *
 * One transaction, lock order: order → allocation → payment (same as cancelPaidOrder /
 * markRefundSucceeded). The allocation row is kept (`reversed_at/by`, reason), its payment
 * becomes CANCELLED and `orders.amount_paid` is recomputed from the remaining captured payments.
 *
 * When that leaves a PAID order under-paid it goes back to AWAITING_PAYMENT (keeping its payment
 * reference): items CONFIRMED → PENDING (the seats stay held, Redis mirror S → R), tickets are
 * voided, `paid_at` is cleared and – if an invoice exists – a credit note negates it completely
 * (GoBD; the invoice is superseded so the next payment issues a new one). The payment deadline is kept unless it has passed; reminder / auto-cancel dates are
 * recomputed so dunning does not cancel the order right away. Paying the order again issues a
 * NEW invoice and NEW tickets (`findActiveInvoice`, `ensureOrderTickets`).
 *
 * The bank transaction returns to the review queue (Klärfälle) so it can be assigned to the right
 * order. No customer e-mail is sent. Only PAID / AWAITING_PAYMENT / PENDING orders qualify;
 * refunds on the payment, checked-in tickets (when tickets would be voided) and finished orders
 * block the reversal.
 */

export interface ReverseAllocationParams {
  allocationId: string;
  userId: string;
  /** Required explanation (stored with the allocation, the order history and the audit log). */
  reason: string;
}

export interface ReverseAllocationResult {
  orderId: string;
  orderNumber: string;
  bankTransactionId: string;
  orderStatus: OrderStatus;
  amountPaid: number;
  /** The order went back to AWAITING_PAYMENT (tickets voided, credit note if invoiced). */
  reopened: boolean;
  ticketsVoided: number;
  creditNote: { id: string; number: string } | null;
}

/**
 * Deadlines of an order that awaits payment again: the original due date is kept unless it has
 * passed; reminder / auto-cancel are recomputed from now and dropped when they would fire at once.
 */
async function deadlinesFor(
  ctx: CoreContext,
  tx: Transaction,
  order: { id: string; paymentDueAt: Date | null },
  now: Date,
) {
  const eventRows = await tx
    .select({
      startsAt: events.startsAt,
      bankTransferPaymentTermDays: events.bankTransferPaymentTermDays,
      bankTransferReminderAfterDays: events.bankTransferReminderAfterDays,
      bankTransferCancelAfterDays: events.bankTransferCancelAfterDays,
      bankTransferAutoCancel: events.bankTransferAutoCancel,
    })
    .from(orderItems)
    .innerJoin(events, eq(events.id, orderItems.eventId))
    .where(
      and(eq(orderItems.orderId, order.id), inArray(orderItems.status, ['PENDING', 'CONFIRMED'])),
    );
  const [bank, general] = await Promise.all([
    getSetting(ctx, 'bankTransfer'),
    getSetting(ctx, 'general'),
  ]);
  const terms =
    eventRows.length > 0
      ? computeBankTransferTerms({
          bank,
          timeZone: general.defaultTimeZone,
          events: eventRows,
          now,
        })
      : null;
  const keepDue = order.paymentDueAt && order.paymentDueAt.getTime() > now.getTime();
  const paymentDueAt =
    keepDue && order.paymentDueAt
      ? order.paymentDueAt
      : (terms?.paymentDueAt ?? new Date(now.getTime() + 7 * 86_400_000));
  const later = (d: Date | null | undefined) => (d && d.getTime() > now.getTime() ? d : null);
  const autoCancelAt = later(
    terms?.autoCancelAt && terms.autoCancelAt < paymentDueAt ? paymentDueAt : terms?.autoCancelAt,
  );
  return {
    firstEventStart: Math.min(...eventRows.map((e) => e.startsAt.getTime())),
    fields: {
      paymentDueAt,
      nextReminderAt: later(terms?.nextReminderAt),
      autoCancelAt,
    },
  };
}

const REVERSIBLE_ORDER_STATUSES: readonly OrderStatus[] = ['PAID', 'AWAITING_PAYMENT', 'PENDING'];
const MUTEX_TTL_MS = 120_000;

export async function reverseBankAllocation(
  ctx: CoreContext,
  params: ReverseAllocationParams,
): Promise<ReverseAllocationResult> {
  const reason = params.reason.trim().slice(0, 1000);
  if (!reason) throw new DomainError('REASON_REQUIRED', 'A reason is required', 422);
  const [head] = await ctx.db
    .select({
      orderId: bankTransactionAllocations.orderId,
      bankTransactionId: bankTransactionAllocations.bankTransactionId,
    })
    .from(bankTransactionAllocations)
    .where(eq(bankTransactionAllocations.id, params.allocationId));
  if (!head) throw new DomainError('ALLOCATION_NOT_FOUND', 'Allocation not found', 404);

  // Same mutex as assign / ignore / rematch: no concurrent change of the transaction's allocations.
  const locked = await withMutex(ctx, `bank-tx:${head.bankTransactionId}`, MUTEX_TTL_MS, () =>
    withTransaction(ctx.db, async (tx) => {
      // Lock order everywhere: ticket advisory lock, then order, allocation, payment.
      await lockOrderTickets(tx, head.orderId);
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, head.orderId))
        .for('update');
      if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
      const [allocation] = await tx
        .select()
        .from(bankTransactionAllocations)
        .where(eq(bankTransactionAllocations.id, params.allocationId))
        .for('update');
      if (!allocation) throw new DomainError('ALLOCATION_NOT_FOUND', 'Allocation not found', 404);
      if (allocation.reversedAt) {
        throw new DomainError(
          'ALLOCATION_ALREADY_REVERSED',
          'This allocation was already reversed',
          409,
        );
      }
      const [payment] = allocation.paymentId
        ? await tx
            .select()
            .from(payments)
            .where(eq(payments.id, allocation.paymentId))
            .for('update')
        : [];
      if (payment) {
        const [refund] = await tx
          .select({ id: refunds.id })
          .from(refunds)
          .where(eq(refunds.paymentId, payment.id))
          .limit(1);
        if (refund) {
          throw new DomainError(
            'REVERSAL_BLOCKED_REFUNDS',
            'Money of this payment was already refunded',
            409,
          );
        }
      }
      // An overpayment refund (any state) is bound to the money of the whole order: reversing a
      // payment afterwards would make the amounts paid / refunded inconsistent.
      const [overpaymentRefund] = await tx
        .select({ id: refunds.id })
        .from(refunds)
        .where(and(eq(refunds.orderId, order.id), eq(refunds.overpayment, true)))
        .limit(1);
      if (overpaymentRefund) {
        throw new DomainError(
          'REVERSAL_BLOCKED_REFUNDS',
          'An overpayment of this order was refunded – the assignment cannot be reversed',
          409,
        );
      }
      if (payment?.adjustmentId) {
        // Money of an additional payment (tariff change) is not reversed here: cancel the
        // tickets of the order or refund instead.
        throw new DomainError(
          'REVERSAL_BLOCKED_ADJUSTMENT',
          'This payment belongs to an additional payment (tariff change) and cannot be reversed',
          409,
        );
      }
      if (
        !payment ||
        payment.orderId !== order.id ||
        payment.status !== 'CAPTURED' ||
        !REVERSIBLE_ORDER_STATUSES.includes(order.status)
      ) {
        throw new DomainError(
          'REVERSAL_BLOCKED_STATE',
          'The allocation cannot be reversed in the current order state',
          409,
          { status: order.status },
        );
      }

      const now = new Date();
      await tx
        .update(payments)
        .set({
          status: 'CANCELLED',
          failureCode: 'ALLOCATION_REVERSED',
          failureMessage: reason,
          updatedAt: now,
        })
        .where(eq(payments.id, payment.id));
      const [sum] = await tx
        .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)::int` })
        .from(payments)
        .where(
          and(
            eq(payments.orderId, order.id),
            inArray(payments.status, ['CAPTURED', 'PARTIALLY_REFUNDED']),
          ),
        );
      const amountPaid = sum?.total ?? 0;
      // An open tariff change that was settled partly by credit relies on the overpayment: do not
      // take that money away.
      const openAdjustment = await findOpenAdjustment(tx, order.id);
      if (openAdjustment && openAdjustment.creditApplied > 0) {
        const { credit } = await orderCredit(tx, order);
        if (credit < openAdjustment.creditApplied) {
          throw new DomainError(
            'REVERSAL_BLOCKED_ADJUSTMENT',
            'An open additional payment (tariff change) is credited with this money – cancel it first',
            409,
          );
        }
      }
      if (amountPaid < order.amountRefunded) {
        throw new DomainError(
          'REVERSAL_BLOCKED_REFUNDS',
          'Money of this order was already refunded',
          409,
        );
      }

      // Under-paid = less than the total minus a shortfall that was written off when the order
      // was settled (current paid cycle): reversing only an overpayment keeps the order PAID.
      const [writeOff] = await tx
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
      const reopen =
        order.status === 'PAID' && amountPaid < order.totalGross - (writeOff?.shortfall ?? 0);
      let released: { seatId: string | null; eventId: string }[] = [];
      let ticketsVoided = 0;
      let creditNote: { id: string; number: string } | null = null;
      let newStatus: OrderStatus = order.status;

      if (reopen) {
        // An open or paid additional payment is built on the paid order: it must not reopen.
        const [adjustment] = await tx
          .select({ id: orderAdjustments.id })
          .from(orderAdjustments)
          .where(
            and(
              eq(orderAdjustments.orderId, order.id),
              inArray(orderAdjustments.status, ['PROPOSED', 'CONFIRMED', 'PAID']),
            ),
          )
          .limit(1);
        if (adjustment) {
          throw new DomainError(
            'REVERSAL_BLOCKED_ADJUSTMENT',
            'The order has an additional payment (tariff change) - cancel it first',
            409,
          );
        }
        if (order.paymentMethod !== 'BANK_TRANSFER') {
          throw new DomainError(
            'REVERSAL_BLOCKED_PAYPAL_ORDER',
            'The order was placed with another payment method - cancel it instead',
            409,
            { status: order.status },
          );
        }
        if (!order.paymentReference) {
          throw new DomainError(
            'REVERSAL_BLOCKED_STATE',
            'The order has no payment reference',
            409,
            {
              status: order.status,
            },
          );
        }
        const [checkedIn] = await tx
          .select({ id: tickets.id })
          .from(tickets)
          .where(and(eq(tickets.orderId, order.id), ne(tickets.checkInState, 'NONE')))
          .limit(1);
        if (checkedIn) {
          throw new DomainError(
            'REVERSAL_BLOCKED_CHECKED_IN',
            'A ticket of this order was already checked in',
            409,
          );
        }
        const terms = await deadlinesFor(ctx, tx, order, now);
        if (terms.firstEventStart <= now.getTime()) {
          throw new DomainError(
            'REVERSAL_BLOCKED_EVENT_STARTED',
            'An event of this order has started - cancel the order instead',
            409,
          );
        }
        newStatus = 'AWAITING_PAYMENT';
        const items = await tx
          .update(orderItems)
          .set({ status: 'PENDING' })
          .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, 'CONFIRMED')))
          .returning({
            id: orderItems.id,
            seatId: orderItems.seatId,
            eventId: orderItems.eventId,
          });
        released = items;
        ticketsVoided = await voidTicketsForItems(
          tx,
          items.map((i) => i.id),
          'CANCELLED',
        );
        creditNote = await issueFullCreditNote(ctx, tx, order.id);
        // The confirmation of the undone payment must not be sent any more.
        await tx
          .update(emailMessages)
          .set({ status: 'FAILED', lastError: 'superseded by allocation reversal', updatedAt: now })
          .where(
            and(
              eq(emailMessages.orderId, order.id),
              inArray(emailMessages.templateKey, [
                'PAYMENT_RECEIVED_TICKETS',
                'ADDITIONAL_PAYMENT_RECEIVED',
                'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT',
              ]),
              inArray(emailMessages.status, ['QUEUED', 'FAILED']),
            ),
          );
        await tx
          .update(orders)
          .set({
            status: newStatus,
            amountPaid,
            paidAt: null,
            paidCycle: sql`${orders.paidCycle} + 1`,
            ...terms.fields,
            version: sql`${orders.version} + 1`,
            updatedAt: now,
          })
          .where(eq(orders.id, order.id));
      } else if (order.status === 'AWAITING_PAYMENT' && amountPaid === 0) {
        // Nothing paid any more: dunning must not act on dates from before the payment.
        const terms = await deadlinesFor(ctx, tx, order, now);
        await tx
          .update(orders)
          .set({ amountPaid, ...terms.fields, version: sql`${orders.version} + 1`, updatedAt: now })
          .where(eq(orders.id, order.id));
      } else {
        await tx
          .update(orders)
          .set({ amountPaid, version: sql`${orders.version} + 1`, updatedAt: now })
          .where(eq(orders.id, order.id));
      }

      await tx
        .update(bankTransactionAllocations)
        .set({ reversedAt: now, reversedByUserId: params.userId, reversalReason: reason })
        .where(eq(bankTransactionAllocations.id, allocation.id));

      // Back to the review queue (the rest of a collective transfer may still be allocated).
      const [bankTx] = await tx
        .select()
        .from(bankTransactions)
        .where(eq(bankTransactions.id, allocation.bankTransactionId))
        .for('update');
      if (bankTx) {
        await tx
          .update(bankTransactions)
          .set({
            matchStatus: 'NEEDS_REVIEW',
            reviewReason: bankTx.reviewReason ?? 'AMBIGUOUS',
            // The order it was wrongly assigned to is no candidate any more.
            matchCandidates: (bankTx.matchCandidates ?? []).filter((c) => c.orderId !== order.id),
            reviewedByUserId: params.userId,
            reviewedAt: now,
            reviewNote: reason,
            updatedAt: now,
          })
          .where(eq(bankTransactions.id, bankTx.id));
      }

      await tx.insert(orderHistory).values({
        orderId: order.id,
        type: ALLOCATION_REVERSED_HISTORY,
        fromStatus: order.status,
        toStatus: newStatus,
        actorType: 'ADMIN',
        actorUserId: params.userId,
        data: {
          allocationId: allocation.id,
          bankTransactionId: allocation.bankTransactionId,
          paymentId: payment.id,
          amount: allocation.amount,
          amountPaid,
          reason,
          reopened: reopen,
          ticketsVoided,
          creditNote: creditNote?.number ?? null,
        },
      });
      return {
        result: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          bankTransactionId: allocation.bankTransactionId,
          orderStatus: newStatus,
          amountPaid,
          reopened: reopen,
          ticketsVoided,
          creditNote,
        } satisfies ReverseAllocationResult,
        released,
      };
    }),
  );
  if (!locked) throw new DomainError('BUSY', 'The transaction is being processed – try again', 409);
  const { result, released } = locked.value;

  // After commit: nothing below may turn the committed reversal into an error.
  if (released.length > 0) {
    try {
      await mirrorSeats(ctx, released, 'R');
    } catch (err) {
      console.error('[allocation-reversal] seat mirror update failed after commit', err);
    }
  }
  if (result.creditNote) {
    try {
      await enqueueInvoiceRender(ctx, result.creditNote.id);
    } catch (err) {
      console.error(
        '[allocation-reversal] credit note render not queued (rendered on download)',
        err,
      );
    }
  }
  return result;
}
