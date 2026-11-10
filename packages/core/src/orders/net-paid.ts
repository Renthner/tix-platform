import { payments, refunds, type Executor } from '@tix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { MONEY_RESERVING_REFUND_STATUSES } from './refund-state';

/**
 * Net money of an order: what was received (payments that are not cancelled / failed) minus the
 * refunds that already claim it. FAILED refunds count as claimed on purpose – they can still be
 * retried or paid back by hand, so that money must not be used a second time (e.g. as credit).
 * Payments and refunds cancel each other symmetrically, also for orphan / duplicate captures.
 */
export async function orderNetPaid(db: Executor, orderId: string): Promise<number> {
  const [received] = await db
    .select({ sum: sql<number>`coalesce(sum(${payments.amount}), 0)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        inArray(payments.status, ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']),
      ),
    );
  const [refunded] = await db
    .select({ sum: sql<number>`coalesce(sum(${refunds.amount}), 0)::int` })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, orderId),
        inArray(refunds.status, [...MONEY_RESERVING_REFUND_STATUSES]),
      ),
    );
  return (received?.sum ?? 0) - (refunded?.sum ?? 0);
}
