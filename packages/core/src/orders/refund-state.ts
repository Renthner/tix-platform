import { orderHistory, orders, payments, refundItems, refunds, type Executor } from '@tix/db';
import type { ActorType } from '@tix/shared';
import { and, eq, exists, inArray, or, sql } from 'drizzle-orm';

/**
 * Refund bookkeeping shared by the admin workflow, the PayPal job and the PayPal webhook.
 * Money aggregates (`orders.amount_refunded`, `payments.status`) are always RECOMPUTED from
 * the SUCCEEDED refund rows, never incremented – a job that runs twice cannot double-count.
 */

/** Refund states that already claim money of a payment (FAILED ones can be retried). */
export const MONEY_RESERVING_REFUND_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;

export async function syncRefundTotals(
  tx: Executor,
  orderId: string,
  paymentId: string | null,
): Promise<void> {
  const [orderSum] = await tx
    .select({ total: sql<number>`COALESCE(SUM(${refunds.amount}), 0)::int` })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, orderId),
        eq(refunds.status, 'SUCCEEDED'),
        // Only refunds of order items / fees and of overpayments (both are part of amount_paid);
        // refunds of orphan captures (late payments after a cancellation) are not.
        or(
          eq(refunds.overpayment, true),
          exists(
            tx
              .select({ one: sql`1` })
              .from(refundItems)
              .where(eq(refundItems.refundId, refunds.id)),
          ),
        ),
      ),
    );
  // No version bump: refund bookkeeping must not invalidate an admin's open order page.
  await tx
    .update(orders)
    .set({
      amountRefunded: sql`LEAST(${orderSum?.total ?? 0}, ${orders.amountPaid})`,
    })
    .where(eq(orders.id, orderId));
  if (!paymentId) return;
  const [paymentSum] = await tx
    .select({ total: sql<number>`COALESCE(SUM(${refunds.amount}), 0)::int` })
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'SUCCEEDED')));
  const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) return;
  const total = paymentSum?.total ?? 0;
  const status = total <= 0 ? null : total >= payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if (status && payment.status !== status) {
    await tx
      .update(payments)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(payments.id, paymentId),
          inArray(payments.status, ['CAPTURED', 'PARTIALLY_REFUNDED']),
        ),
      );
  }
}

export interface RefundSuccess {
  providerRefundId?: string | null;
  actor: { type: ActorType; userId?: string | null };
  note?: string | null;
}

/**
 * PENDING/FAILED → SUCCEEDED (conditional update, so concurrent callers settle it once) and
 * recomputes the totals. Returns false when the refund was already settled.
 */
export async function markRefundSucceeded(
  tx: Executor,
  refundId: string,
  success: RefundSuccess,
): Promise<boolean> {
  // Lock order → refund (same order as cancelPaidOrder) so concurrent settlements of refunds of
  // one order cannot overwrite each other's recomputed totals.
  const [target] = await tx
    .select({ orderId: refunds.orderId })
    .from(refunds)
    .where(eq(refunds.id, refundId));
  if (!target) return false;
  await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, target.orderId))
    .for('update');
  const now = new Date();
  const [row] = await tx
    .update(refunds)
    .set({
      status: 'SUCCEEDED',
      processedAt: now,
      failureMessage: null,
      ...(success.providerRefundId ? { providerRefundId: success.providerRefundId } : {}),
      ...(success.actor.type === 'ADMIN'
        ? { completedAt: now, completedByUserId: success.actor.userId ?? null }
        : {}),
      ...(success.note ? { note: success.note } : {}),
      updatedAt: now,
    })
    .where(and(eq(refunds.id, refundId), inArray(refunds.status, ['PENDING', 'FAILED'])))
    .returning({
      orderId: refunds.orderId,
      paymentId: refunds.paymentId,
      amount: refunds.amount,
      kind: refunds.kind,
    });
  if (!row) return false;
  await syncRefundTotals(tx, row.orderId, row.paymentId);
  await tx.insert(orderHistory).values({
    orderId: row.orderId,
    type: 'refund_completed',
    actorType: success.actor.type,
    actorUserId: success.actor.userId ?? null,
    data: { refundId, amount: row.amount, kind: row.kind, note: success.note ?? null },
  });
  return true;
}
