import {
  orderAdjustments,
  orderHistory,
  orders,
  payments,
  type Executor,
  type Transaction,
} from '@tix/db';
import type { ActorType } from '@tix/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { createEmailMessage } from '../email';

/**
 * Small, dependency-free helpers around `order_adjustments` (additional payments, see
 * `adjustments.ts`). Kept apart so the refund / reversal flows can use them without importing the
 * whole adjustment workflow.
 */

/** An open adjustment waits for the customer's confirmation or payment. */
export const OPEN_ADJUSTMENT_STATUSES = ['PROPOSED', 'CONFIRMED'] as const;

export type AdjustmentRow = typeof orderAdjustments.$inferSelect;

/**
 * An additional payment for this order item is still open: the ticket stays VALID but the
 * scanner shows the yellow warning "additional payment open" (Phase 6, never blocks entry).
 */
export async function ticketHasOpenAdjustment(
  db: Executor,
  ticket: { orderItemId: string; orderId?: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: orderAdjustments.id })
    .from(orderAdjustments)
    .where(
      and(
        ticket.orderId ? eq(orderAdjustments.orderId, ticket.orderId) : undefined,
        inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
        sql`${orderAdjustments.items} @> ${JSON.stringify([{ orderItemId: ticket.orderItemId }])}::jsonb`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Order item ids with an open adjustment, for bulk scanner sync reads (one query per call). */
export async function openAdjustmentItemIds(
  db: Executor,
  orderIds: readonly string[],
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await db
    .select({ items: orderAdjustments.items })
    .from(orderAdjustments)
    .where(
      and(
        inArray(orderAdjustments.orderId, [...orderIds]),
        inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
      ),
    );
  return new Set(rows.flatMap((r) => r.items.map((i) => i.orderItemId)));
}

/** The open (PROPOSED / CONFIRMED) adjustment of an order, if any. */
export async function findOpenAdjustment(
  db: Executor,
  orderId: string,
): Promise<AdjustmentRow | null> {
  const [row] = await db
    .select()
    .from(orderAdjustments)
    .where(
      and(
        eq(orderAdjustments.orderId, orderId),
        inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
      ),
    );
  return row ?? null;
}

/**
 * Cancels the open adjustment of an order inside the caller's transaction (order row already
 * locked by the caller). Nothing else needs undoing: items, totals and tickets were never touched.
 * Open PayPal attempts of the adjustment are closed so a late approval is not captured.
 * Returns the cancelled adjustment or null when there was none.
 */
export async function cancelOpenAdjustmentInTransaction(
  tx: Transaction,
  orderId: string,
  params: { actor: { type: ActorType; userId?: string | null }; reason?: string | null },
): Promise<AdjustmentRow | null> {
  const [cancelled] = await tx
    .update(orderAdjustments)
    .set({
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy: params.actor.type,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orderAdjustments.orderId, orderId),
        inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
      ),
    )
    .returning();
  if (!cancelled) return null;
  await tx
    .update(payments)
    .set({
      status: 'CANCELLED',
      failureCode: 'ADJUSTMENT_CANCELLED',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(payments.adjustmentId, cancelled.id),
        inArray(payments.status, ['CREATED', 'APPROVED']),
      ),
    );
  await tx
    .update(orders)
    .set({ version: sql`${orders.version} + 1` })
    .where(eq(orders.id, orderId));
  await tx.insert(orderHistory).values({
    orderId,
    type: 'adjustment_cancelled',
    actorType: params.actor.type,
    actorUserId: params.actor.userId ?? null,
    data: {
      adjustmentId: cancelled.id,
      amount: cancelled.amount,
      reference: cancelled.paymentReference,
      reason: params.reason?.trim() || null,
    },
  });
  return cancelled;
}

/**
 * Outbox row telling the customer that the additional payment is void (cancelled by an admin,
 * cancelled with the tickets or no longer applicable). Null without an e-mail address. The caller
 * dispatches the returned message after its transaction committed.
 */
export async function queueAdjustmentCancelledMail(
  ctx: CoreContext,
  db: Executor,
  adjustment: Pick<AdjustmentRow, 'id' | 'orderId'>,
): Promise<string | null> {
  const [order] = await db
    .select({ email: orders.email })
    .from(orders)
    .where(eq(orders.id, adjustment.orderId));
  if (!order?.email) return null;
  return createEmailMessage(ctx, db, {
    key: 'ADDITIONAL_PAYMENT_CANCELLED',
    orderId: adjustment.orderId,
    variables: { adjustmentId: adjustment.id },
  });
}
