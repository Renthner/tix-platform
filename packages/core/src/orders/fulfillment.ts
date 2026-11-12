import { coreLog } from '../log';
import {
  orderHistory,
  orderItems,
  orders,
  payments,
  seatMapSections,
  seats,
  withTransaction,
  type Transaction,
} from '@tix/db';
import type { TakenCode } from '@tix/redis';
import type { ActorType, OrderStatus, PaymentMethod } from '@tix/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { QUEUE_NAMES } from '../job-queues';
import { publishSeatDelta } from '../realtime';
import { voidTicketsForItems } from '../tickets/issue';
import { currentPaidCycle, orderPaidJobId } from './paid-cycle';

/**
 * Order state transitions that move money or inventory:
 *  - `recordPayment`: a captured payment (PayPal capture, bank transfer, box office)
 *    → order PAID once fully covered, items CONFIRMED, seats SOLD, fulfilment job queued.
 *  - `cancelOrder`: unpaid order CANCELLED / EXPIRED → items cancelled, seats and standing
 *    spots released back to the public pool (live broadcast).
 * PostgreSQL is the authority; the Redis inventory mirror is updated after commit.
 */

export interface OrderActor {
  type: ActorType;
  userId?: string | null;
}

export interface PaymentReceipt {
  orderId: string;
  /** Captured amount in cents (> 0). */
  amount: number;
  currency: string;
  method: PaymentMethod;
  capturedAt?: Date;
  /** PayPal order / capture ids (idempotency for webhooks + return URL). */
  providerOrderId?: string | null;
  providerCaptureId?: string | null;
  /** Bank transaction the money came from (reconciliation). */
  bankTransactionId?: string | null;
  receivedByUserId?: string | null;
  providerResponse?: unknown;
  actor: OrderActor;
  /**
   * Accept an underpayment of at most this many cents as full payment (bank-transfer
   * matching tolerance): the order becomes PAID and the written-off shortfall is logged.
   */
  settleShortfallUpTo?: number;
}

export type RecordPaymentResult =
  /** Order became fully paid with this payment. */
  | { status: 'PAID'; orderId: string; paymentId: string }
  /** Payment recorded, order still awaits `outstanding` cents. */
  | { status: 'PARTIAL'; orderId: string; paymentId: string; outstanding: number }
  /** Order was already paid – the payment is recorded as overpayment. */
  | { status: 'ALREADY_PAID'; orderId: string; paymentId: string }
  /** The same capture / bank transaction was recorded before (idempotent no-op). */
  | { status: 'DUPLICATE'; orderId: string; paymentId: string }
  /** Order is cancelled / expired / refunded – nothing recorded (needs manual review). */
  | { status: 'NOT_PAYABLE'; orderId: string; orderStatus: OrderStatus };

const NOT_PAYABLE: readonly OrderStatus[] = [
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
];

export async function recordPayment(
  ctx: CoreContext,
  receipt: PaymentReceipt,
): Promise<RecordPaymentResult> {
  if (!Number.isInteger(receipt.amount) || receipt.amount <= 0) {
    throw new DomainError('INVALID_AMOUNT', 'Payment amount must be positive', 422);
  }
  const outcome = await withTransaction(ctx.db, async (tx) => {
    const duplicate = await findDuplicatePayment(tx, receipt);
    if (duplicate) {
      return {
        result: { status: 'DUPLICATE', orderId: receipt.orderId, paymentId: duplicate } as const,
        seats: [],
      };
    }
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, receipt.orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (NOT_PAYABLE.includes(order.status)) {
      return {
        result: { status: 'NOT_PAYABLE', orderId: order.id, orderStatus: order.status } as const,
        seats: [],
      };
    }
    if (receipt.currency !== order.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Payment currency differs from the order', 422);
    }
    const capturedAt = receipt.capturedAt ?? new Date();
    const captured = {
      status: 'CAPTURED' as const,
      amount: receipt.amount,
      currency: receipt.currency,
      providerCaptureId: receipt.providerCaptureId ?? null,
      bankTransactionId: receipt.bankTransactionId ?? null,
      receivedByUserId: receipt.receivedByUserId ?? null,
      providerResponse: receipt.providerResponse ?? null,
      capturedAt,
      failureCode: null,
      failureMessage: null,
    };
    // A PayPal payment attempt (CREATED/APPROVED row of the provider order) is completed in
    // place – the provider order id is unique per method.
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
        result: { status: 'DUPLICATE', orderId: order.id, paymentId: attempt.id } as const,
        seats: [],
      };
    }
    const [payment] = attempt
      ? await tx
          .update(payments)
          .set({ ...captured, updatedAt: new Date() })
          .where(eq(payments.id, attempt.id))
          .returning({ id: payments.id })
      : await tx
          .insert(payments)
          .values({
            orderId: order.id,
            method: receipt.method,
            providerOrderId: receipt.providerOrderId ?? null,
            ...captured,
          })
          .returning({ id: payments.id });
    const amountPaid = order.amountPaid + receipt.amount;
    const history = (type: string, data: Record<string, unknown>, to?: OrderStatus) =>
      tx.insert(orderHistory).values({
        orderId: order.id,
        type,
        fromStatus: to ? order.status : null,
        toStatus: to ?? null,
        actorType: receipt.actor.type,
        actorUserId: receipt.actor.userId ?? null,
        data,
      });
    const paymentData = { paymentId: payment!.id, method: receipt.method, amount: receipt.amount };

    if (order.status === 'PAID') {
      await tx
        .update(orders)
        .set({ amountPaid, version: sql`${orders.version} + 1` })
        .where(eq(orders.id, order.id));
      await history('payment_received', { ...paymentData, overpayment: true });
      return {
        result: { status: 'ALREADY_PAID', orderId: order.id, paymentId: payment!.id } as const,
        seats: [],
      };
    }
    const shortfall = order.totalGross - amountPaid;
    const writeOff = shortfall > 0 && shortfall <= (receipt.settleShortfallUpTo ?? 0);
    if (amountPaid < order.totalGross && !writeOff) {
      await tx
        .update(orders)
        .set({ amountPaid, version: sql`${orders.version} + 1` })
        .where(eq(orders.id, order.id));
      await history('payment_partial', {
        ...paymentData,
        outstanding: order.totalGross - amountPaid,
      });
      return {
        result: {
          status: 'PARTIAL',
          orderId: order.id,
          paymentId: payment!.id,
          outstanding: order.totalGross - amountPaid,
        } as const,
        seats: [],
      };
    }
    await tx
      .update(orders)
      .set({
        status: 'PAID',
        amountPaid,
        paidAt: capturedAt,
        nextReminderAt: null,
        autoCancelAt: null,
        version: sql`${orders.version} + 1`,
      })
      .where(eq(orders.id, order.id));
    const confirmed = await tx
      .update(orderItems)
      .set({ status: 'CONFIRMED' })
      .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, 'PENDING')))
      .returning({ seatId: orderItems.seatId, eventId: orderItems.eventId });
    if (writeOff) {
      await history('shortfall_written_off', {
        ...paymentData,
        shortfall,
        paidCycle: order.paidCycle,
      });
    }
    await history('status_changed', paymentData, 'PAID');
    return {
      result: { status: 'PAID', orderId: order.id, paymentId: payment!.id } as const,
      seats: confirmed,
    };
  });

  if (outcome.result.status === 'PAID') {
    await mirrorSeats(ctx, outcome.seats, 'S');
    // Invoice + payment confirmation (+ tickets from phase 4) – retried by the worker.
    await ctx.jobs?.add(
      QUEUE_NAMES.documents,
      'order-paid',
      {
        orderId: outcome.result.orderId,
        paidCycle: await currentPaidCycle(ctx.db, outcome.result.orderId),
      },
      { jobId: await orderPaidJobId(ctx.db, outcome.result.orderId) },
    );
  }
  return outcome.result;
}

async function findDuplicatePayment(
  tx: Transaction,
  receipt: PaymentReceipt,
): Promise<string | null> {
  if (receipt.providerCaptureId) {
    const [row] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.providerCaptureId, receipt.providerCaptureId),
          // A pending capture (APPROVED attempt) is completed in place, not a duplicate.
          inArray(payments.status, ['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED']),
        ),
      );
    if (row) return row.id;
  }
  if (receipt.bankTransactionId) {
    // A payment cancelled by a reversed bank allocation does not block assigning the same
    // transaction to the order again.
    const [row] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.bankTransactionId, receipt.bankTransactionId),
          eq(payments.orderId, receipt.orderId),
          ne(payments.status, 'CANCELLED'),
        ),
      );
    if (row) return row.id;
  }
  return null;
}

export interface CancelOrderParams {
  orderId: string;
  /** CANCELLED (admin, dunning) or EXPIRED (abandoned online payment). */
  status: 'CANCELLED' | 'EXPIRED';
  reason?: string | null;
  actor: OrderActor;
  /** Send the ORDER_CANCELLED e-mail (dunning / admin cancellation of a bank transfer). */
  notifyCustomer?: boolean;
}

/**
 * Cancels an unpaid order (PENDING / AWAITING_PAYMENT) and releases its seats and standing
 * spots. Paid orders need the refund workflow (phase 5). Returns false if the order was not
 * in a cancellable state (e.g. paid in the meantime) – safe to call from concurrent jobs.
 */
export async function cancelOrder(ctx: CoreContext, params: CancelOrderParams): Promise<boolean> {
  const outcome = await withTransaction(ctx.db, async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (order.status !== 'PENDING' && order.status !== 'AWAITING_PAYMENT') return null;
    const now = new Date();
    await tx
      .update(orders)
      .set({
        status: params.status,
        ...(params.status === 'CANCELLED' ? { cancelledAt: now } : { expiredAt: now }),
        cancellationReason: params.reason ?? null,
        nextReminderAt: null,
        autoCancelAt: null,
        version: sql`${orders.version} + 1`,
      })
      .where(eq(orders.id, order.id));
    const items = await tx
      .update(orderItems)
      .set({ status: 'CANCELLED', cancelledAt: now })
      .where(
        and(eq(orderItems.orderId, order.id), inArray(orderItems.status, ['PENDING', 'CONFIRMED'])),
      )
      .returning({
        id: orderItems.id,
        seatId: orderItems.seatId,
        eventId: orderItems.eventId,
        sectionId: orderItems.sectionId,
        kind: orderItems.kind,
      });
    // Unpaid orders normally have no tickets; void any that exist so they can never be scanned.
    await voidTicketsForItems(
      tx,
      items.map((i) => i.id),
      'CANCELLED',
    );
    // Standing areas: give the spots back to the DB capacity counter.
    const gaBySection = new Map<string, number>();
    for (const item of items) {
      if (item.kind === 'GENERAL_ADMISSION')
        gaBySection.set(item.sectionId, (gaBySection.get(item.sectionId) ?? 0) + 1);
    }
    for (const [sectionId, n] of gaBySection) {
      await tx
        .update(seatMapSections)
        .set({ allocatedCount: sql`GREATEST(${seatMapSections.allocatedCount} - ${n}, 0)` })
        .where(eq(seatMapSections.id, sectionId));
    }
    await tx.insert(orderHistory).values({
      orderId: order.id,
      type: 'status_changed',
      fromStatus: order.status,
      toStatus: params.status,
      actorType: params.actor.type,
      actorUserId: params.actor.userId ?? null,
      data: {
        ...(params.reason ? { reason: params.reason } : {}),
        orderItemIds: items.map((i) => i.id),
      },
    });
    const messageId = params.notifyCustomer
      ? await createEmailMessage(ctx, tx, { key: 'ORDER_CANCELLED', orderId: order.id })
      : null;
    return { items, messageId };
  });
  if (!outcome) return false;
  await releaseInventory(ctx, outcome.items);
  if (outcome.messageId) {
    await dispatchEmailMessage(ctx, outcome.messageId).catch((err: unknown) =>
      coreLog.error({ err }, '[orders] cancellation e-mail stored but not queued (outbox retries)'),
    );
  }
  return true;
}

/**
 * After the transaction that released items (cancel / refund): clears the Redis "taken" mirror of
 * their seats, gives standing spots back to the Redis counter and broadcasts the new availability.
 */
export async function releaseInventory(
  ctx: CoreContext,
  released: readonly {
    seatId: string | null;
    eventId: string;
    sectionId: string;
    kind: string;
  }[],
): Promise<void> {
  await mirrorSeats(ctx, released, null);
  const gaByEvent = new Map<string, Record<string, number>>();
  for (const item of released) {
    if (item.kind !== 'GENERAL_ADMISSION') continue;
    const sections = gaByEvent.get(item.eventId) ?? {};
    sections[item.sectionId] = (sections[item.sectionId] ?? 0) + 1;
    gaByEvent.set(item.eventId, sections);
  }
  for (const [eventId, sections] of gaByEvent) {
    await ctx.seats.releaseGeneralAdmission(eventId, sections);
    const remaining = await ctx.seats.generalAdmissionRemaining(eventId);
    await publishSeatDelta(ctx, {
      eventId,
      seats: [],
      ga: Object.fromEntries(Object.keys(sections).map((s) => [s, remaining[s] ?? 0])),
    });
  }
}

/** Updates the Redis "taken" mirror for order seats and broadcasts the change. */
export async function mirrorSeats(
  ctx: CoreContext,
  items: readonly { seatId: string | null; eventId: string }[],
  code: 'S' | 'R' | null,
): Promise<void> {
  const byEvent = new Map<string, string[]>();
  for (const item of items) {
    if (!item.seatId) continue;
    byEvent.set(item.eventId, [...(byEvent.get(item.eventId) ?? []), item.seatId]);
  }
  for (const [eventId, seatIds] of byEvent) {
    let codes: Record<string, TakenCode | null> = Object.fromEntries(
      seatIds.map((id) => [id, code]),
    );
    if (code === null) {
      // A freed seat that is blocked (press / VIP seat sold at the box office) or removed from
      // the plan must not become sellable online.
      const special = await ctx.db
        .select({ id: seats.id, blockReason: seats.blockReason, removedAt: seats.removedAt })
        .from(seats)
        .where(inArray(seats.id, seatIds));
      for (const s of special) {
        if (s.removedAt) codes[s.id] = 'X';
        else if (s.blockReason) codes[s.id] = 'B';
      }
    }
    await ctx.seats.setTaken(eventId, codes);
    await publishSeatDelta(ctx, {
      eventId,
      // A freed seat that stays blocked / removed is still unavailable for the shop.
      seats: seatIds.map((id) => [id, code === null && codes[id] === null ? 'F' : 'S']),
    });
  }
}
