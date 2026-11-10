import { emailMessages, orders, type Executor } from '@tix/db';
import { and, eq, sql } from 'drizzle-orm';

/** History entry written when a bank allocation is reversed (order back to awaiting payment). */
export const ALLOCATION_REVERSED_HISTORY = 'bank_allocation_reversed';

/**
 * Paid cycles: `orders.paid_cycle` is incremented whenever a bank allocation reversal undoes a
 * payment. Jobs and payment-confirmation e-mails carry the cycle they were created for, so work
 * of an undone payment (stale `order-paid` job, old mail) never counts for the next payment.
 */
export async function currentPaidCycle(db: Executor, orderId: string): Promise<number> {
  const [row] = await db
    .select({ cycle: orders.paidCycle })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.cycle ?? 0;
}

/**
 * BullMQ job id of the `order-paid` job: finished jobs are retained and would swallow a re-add
 * with the same id, so every paid cycle gets its own (cycle 0 keeps the original id).
 */
export async function orderPaidJobId(db: Executor, orderId: string): Promise<string> {
  const cycle = await currentPaidCycle(db, orderId);
  return cycle > 0 ? `order-paid-${orderId}-c${cycle}` : `order-paid-${orderId}`;
}

/** The payment confirmation (PAYMENT_RECEIVED_TICKETS) of this paid cycle exists already. */
export async function hasPaymentMailForCycle(
  db: Executor,
  orderId: string,
  cycle?: number,
): Promise<boolean> {
  const current = cycle ?? (await currentPaidCycle(db, orderId));
  const [mail] = await db
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.orderId, orderId),
        eq(emailMessages.templateKey, 'PAYMENT_RECEIVED_TICKETS'),
        sql`COALESCE(${emailMessages.paidCycle}, 0) = ${current}`,
      ),
    )
    .limit(1);
  return Boolean(mail);
}
