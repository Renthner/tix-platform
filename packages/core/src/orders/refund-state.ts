import {
  orderHistory,
  orders,
  payments,
  refundItems,
  refundReconcileState,
  refunds,
  type Executor,
} from '@tix/db';
import type { ActorType } from '@tix/shared';
import { and, desc, eq, exists, inArray, or, sql } from 'drizzle-orm';

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

/** Cheap check for the refund jobs: Redis flag first, then the durable row. */
export async function isRefundReconcilePending(ctx: {
  redis: { exists(key: string): Promise<number> };
  keys: { refundReconcilePending(): string };
  db: Executor;
}): Promise<boolean> {
  if (await ctx.redis.exists(ctx.keys.refundReconcilePending())) return true;
  const rows = await ctx.db
    .select({ pending: refundReconcileState.pending })
    .from(refundReconcileState)
    .catch(() => []);
  return rows[0]?.pending === true;
}

// ─── Refund review (PayPal state that disagrees with ours) ──────────────────

/**
 * An order is "under review" when PayPal's refunds do not match our rows (found after a restore
 * or announced by a webhook for a refund we did not make). The review is an `order_history`
 * entry; while it is open NO automatic refund of the order is sent (the admin first records the
 * refund that already exists at PayPal or confirms nothing is missing) – otherwise a second
 * PayPal refund would pay the customer twice.
 */
export const REFUND_REVIEW_EVENT = 'refund_restore_review';
export const REFUND_REVIEW_RESOLVED_EVENT = 'refund_restore_review_resolved';

export type RefundReviewKind =
  /** PayPal shows a refund we have no row for (lost window / PayPal dashboard). */
  | 'UNKNOWN_AT_PAYPAL'
  /** Webhook announced a refund we did not make. */
  | 'EXTERNAL_REFUND_NOTICE'
  /** More than one completed PayPal refund carries the same refund row (double payout). */
  | 'DOUBLE_REFUND_AT_PAYPAL'
  /** PayPal's refund has another amount/currency than the row it belongs to. */
  | 'AMOUNT_MISMATCH'
  /** Recorded here as refunded, PayPal does not show a completed refund. */
  | 'LOCAL_SUCCEEDED_NOT_AT_PAYPAL'
  /** PayPal does not know the order (wrong environment/account?) although refunds are open. */
  | 'UNCHECKED_AT_PAYPAL'
  /** PayPal refused the lookup permanently (4xx). */
  | 'CHECK_FAILED';

export interface RefundReviewFinding {
  kind: RefundReviewKind;
  /** PayPal refund id, or our refund row id (LOCAL_SUCCEEDED_NOT_AT_PAYPAL), or the PayPal order id. */
  ref: string;
  amount: number;
  currency: string;
  /** Optional extra: other refund ids / error text. */
  detail?: string;
}

async function latestReviewEntry(tx: Executor, orderId: string) {
  const [latest] = await tx
    .select({ type: orderHistory.type, data: orderHistory.data })
    .from(orderHistory)
    .where(
      and(
        eq(orderHistory.orderId, orderId),
        inArray(orderHistory.type, [REFUND_REVIEW_EVENT, REFUND_REVIEW_RESOLVED_EVENT]),
      ),
    )
    .orderBy(desc(orderHistory.createdAt), desc(orderHistory.id))
    .limit(1);
  return latest ?? null;
}

export async function hasOpenRefundReview(tx: Executor, orderId: string): Promise<boolean> {
  return (await latestReviewEntry(tx, orderId))?.type === REFUND_REVIEW_EVENT;
}

/** Writes the findings once (the same set again adds nothing – also not after it was resolved). */
export async function recordRefundReview(
  tx: Executor,
  orderId: string,
  findings: RefundReviewFinding[],
  actor: ActorType = 'SYSTEM',
): Promise<boolean> {
  if (findings.length === 0) return false;
  const fingerprint = findings
    .map((f) => `${f.kind}:${f.ref}`)
    .sort()
    .join('|');
  const latest = await latestReviewEntry(tx, orderId);
  if ((latest?.data as { fingerprint?: string } | null)?.fingerprint === fingerprint) return false;
  await tx.insert(orderHistory).values({
    orderId,
    type: REFUND_REVIEW_EVENT,
    actorType: actor,
    data: { fingerprint, findings },
  });
  return true;
}

/** Closes the open review (admin looked at it). Returns false when none is open. */
export async function resolveRefundReview(
  tx: Executor,
  orderId: string,
  userId: string,
  note?: string,
): Promise<boolean> {
  const latest = await latestReviewEntry(tx, orderId);
  if (latest?.type !== REFUND_REVIEW_EVENT) return false;
  await tx.insert(orderHistory).values({
    orderId,
    type: REFUND_REVIEW_RESOLVED_EVENT,
    actorType: 'ADMIN',
    actorUserId: userId,
    data: {
      fingerprint: (latest.data as { fingerprint?: string } | null)?.fingerprint ?? null,
      ...(note ? { note } : {}),
    },
  });
  return true;
}

/** Closes the review when every finding concerned the refund that was just recorded. */
export async function resolveReviewIfOnly(
  tx: Executor,
  orderId: string,
  providerRefundId: string,
  userId: string,
): Promise<boolean> {
  const latest = await latestReviewEntry(tx, orderId);
  if (latest?.type !== REFUND_REVIEW_EVENT) return false;
  const findings = (latest.data as { findings?: RefundReviewFinding[] } | null)?.findings ?? [];
  if (findings.length === 0 || !findings.every((f) => f.ref === providerRefundId)) return false;
  return resolveRefundReview(tx, orderId, userId, 'recorded');
}
