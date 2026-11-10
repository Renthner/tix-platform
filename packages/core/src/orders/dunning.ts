import { orderAdjustments, orderHistory, orders } from '@tix/db';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { reconcileAdjustmentPayPal, reconcilePayPalOrder } from '../payments/paypal';
import { getSetting } from '../settings';
import { OPEN_ADJUSTMENT_STATUSES, sendAdjustmentReminders } from './adjustments';
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
 *  4. Additional payments (tariff changes): open PayPal attempts are reconciled and one reminder
 *     is sent after `bankTransfer.adjustmentReminderDays`. Never cancelled automatically.
 */

const BATCH = 200;
/** Give up reconciling with PayPal (API down / not configured) after this long. */
const PAYPAL_FORCE_EXPIRE_MS = 24 * 3600 * 1000;

export interface DunningResult {
  reminded: number;
  adjustmentsReminded: number;
  cancelled: number;
  expired: number;
  errors: number;
}

export async function runDunning(ctx: CoreContext, now = new Date()): Promise<DunningResult> {
  const result: DunningResult = {
    reminded: 0,
    adjustmentsReminded: 0,
    cancelled: 0,
    expired: 0,
    errors: 0,
  };
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

  // 4. Additional payments: PayPal reconciliation, then the single reminder.
  const openAdjustments = await ctx.db
    .select({ id: orderAdjustments.id })
    .from(orderAdjustments)
    .where(
      and(
        inArray(orderAdjustments.status, [...OPEN_ADJUSTMENT_STATUSES]),
        // Only those with a PayPal attempt in flight: the rest has nothing to reconcile, so a
        // large backlog cannot starve the ones that do.
        sql`exists (select 1 from payments p where p.adjustment_id = ${orderAdjustments.id} and p.method = 'PAYPAL' and p.status in ('CREATED','APPROVED'))`,
      ),
    )
    .orderBy(asc(orderAdjustments.updatedAt))
    .limit(BATCH);
  for (const { id } of openAdjustments) {
    try {
      await reconcileAdjustmentPayPal(ctx, id, now);
    } catch (err) {
      report('adjustment-paypal', id, err);
    }
  }
  try {
    result.adjustmentsReminded = await sendAdjustmentReminders(ctx, now);
  } catch (err) {
    report('adjustment-reminder', 'all', err);
  }
  return result;
}
