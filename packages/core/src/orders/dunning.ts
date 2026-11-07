import { orderHistory, orders } from '@tix/db';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { reconcilePayPalOrder } from '../payments/paypal';
import { getSetting } from '../settings';
import { cancelOrder } from './fulfillment';

/**
 * Payment deadlines (run periodically by the worker, idempotent and safe to run in
 * parallel – every transition is claimed with a conditional UPDATE / row lock):
 *
 *  1. Vorkasse reminder: AWAITING_PAYMENT orders whose `next_reminder_at` passed get the
 *     PAYMENT_REMINDER e-mail (once; `reminder_count` / `last_reminder_at` are recorded).
 *  2. Vorkasse auto-cancel: AWAITING_PAYMENT orders past `auto_cancel_at` are cancelled and
 *     their seats released – unless an admin set "keep reserved" or money already arrived
 *     (partial payment → manual review in the admin).
 *  3. PayPal expiry: PENDING PayPal orders older than the approval window are checked at
 *     PayPal first (approved → captured), otherwise EXPIRED and their seats released.
 */

const BATCH = 200;
/** Give up reconciling with PayPal (API down / not configured) after this long. */
const PAYPAL_FORCE_EXPIRE_MS = 24 * 3600 * 1000;

export interface DunningResult {
  reminded: number;
  cancelled: number;
  expired: number;
  errors: number;
}

export async function runDunning(ctx: CoreContext, now = new Date()): Promise<DunningResult> {
  const result: DunningResult = { reminded: 0, cancelled: 0, expired: 0, errors: 0 };
  const report = (scope: string, orderId: string, err: unknown) => {
    result.errors += 1;
    console.error(`[dunning] ${scope} failed for order ${orderId}`, err);
  };

  // 1. Reminders.
  const dueReminders = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, 'AWAITING_PAYMENT'), lte(orders.nextReminderAt, now)))
    .orderBy(asc(orders.nextReminderAt))
    .limit(BATCH);
  for (const { id } of dueReminders) {
    try {
      const messageId = await ctx.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(orders)
          .set({
            nextReminderAt: null,
            lastReminderAt: now,
            reminderCount: sql`${orders.reminderCount} + 1`,
          })
          .where(
            and(
              eq(orders.id, id),
              eq(orders.status, 'AWAITING_PAYMENT'),
              lte(orders.nextReminderAt, now),
            ),
          )
          .returning({ reminderCount: orders.reminderCount });
        if (!claimed) return null;
        await tx.insert(orderHistory).values({
          orderId: id,
          type: 'reminder_sent',
          actorType: 'SYSTEM',
          data: { reminderCount: claimed.reminderCount },
        });
        return createEmailMessage(ctx, tx, { key: 'PAYMENT_REMINDER', orderId: id });
      });
      if (!messageId) continue;
      await dispatchEmailMessage(ctx, messageId).catch((err: unknown) =>
        console.error('[dunning] reminder stored but not queued (outbox retries)', err),
      );
      result.reminded += 1;
    } catch (err) {
      report('reminder', id, err);
    }
  }

  // 2. Vorkasse auto-cancel.
  const overdue = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'AWAITING_PAYMENT'),
        lte(orders.autoCancelAt, now),
        eq(orders.keepReserved, false),
        eq(orders.amountPaid, 0),
      ),
    )
    .orderBy(asc(orders.autoCancelAt))
    .limit(BATCH);
  for (const { id } of overdue) {
    try {
      const done = await cancelOrder(ctx, {
        orderId: id,
        status: 'CANCELLED',
        reason: 'PAYMENT_OVERDUE',
        actor: { type: 'SYSTEM' },
        notifyCustomer: true,
      });
      if (done) result.cancelled += 1;
    } catch (err) {
      report('auto-cancel', id, err);
    }
  }

  // 3. Abandoned PayPal payments.
  const paypal = await getSetting(ctx, 'paypal');
  const cutoff = new Date(now.getTime() - paypal.approvalTimeoutSeconds * 1000);
  const abandoned = await ctx.db
    .select({ id: orders.id, createdAt: orders.createdAt })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'PENDING'),
        eq(orders.paymentMethod, 'PAYPAL'),
        lte(orders.createdAt, cutoff),
      ),
    )
    .orderBy(asc(orders.createdAt))
    .limit(BATCH);
  for (const order of abandoned) {
    try {
      let keep = false;
      try {
        keep = await reconcilePayPalOrder(ctx, order.id);
      } catch (err) {
        // PayPal unreachable: retry on the next run, but never block seats forever.
        if (now.getTime() - order.createdAt.getTime() < PAYPAL_FORCE_EXPIRE_MS) {
          report('paypal-reconcile', order.id, err);
          continue;
        }
      }
      if (keep) continue;
      const done = await cancelOrder(ctx, {
        orderId: order.id,
        status: 'EXPIRED',
        reason: 'PAYMENT_NOT_COMPLETED',
        actor: { type: 'SYSTEM' },
      });
      if (done) result.expired += 1;
    } catch (err) {
      report('paypal-expiry', order.id, err);
    }
  }
  return result;
}
