import { orderHistory, orders } from '@tix/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { coreLog } from '../log';
import { adminCancelOrder, resendOrderTickets, setKeepReserved } from './admin';

/**
 * Bulk actions of the admin order list. Every order is processed on its own (one failure never
 * stops the rest) and the outcome is reported per order. Re-running an action is harmless: orders
 * already in the target state are reported as `skipped`.
 */

export const BULK_ORDER_ACTIONS = [
  'remind',
  'keepReservedOn',
  'keepReservedOff',
  'resendTickets',
  'cancelUnpaid',
] as const;
export type BulkOrderAction = (typeof BULK_ORDER_ACTIONS)[number];

export const BULK_ORDER_LIMIT = 200;
/** A payment reminder is not sent again within this window (double click / re-run). */
export const MANUAL_REMINDER_COOLDOWN_MS = 60 * 60 * 1000;

export interface BulkOrderOutcome {
  orderId: string;
  orderNumber: string;
  outcome: 'done' | 'skipped' | 'failed';
  /** Stable code (DomainError code or `UNCHANGED` / `RECENTLY_REMINDED`). */
  code?: string;
}

/** Sends the payment reminder e-mail of an unpaid Vorkasse order right now. */
export async function sendPaymentReminderNow(
  ctx: CoreContext,
  params: { orderId: string; userId: string; now?: Date },
): Promise<'SENT' | 'RECENTLY_REMINDED'> {
  const now = params.now ?? new Date();
  const messageId = await ctx.db.transaction(async (tx) => {
    const [order] = await tx
      .select({
        status: orders.status,
        method: orders.paymentMethod,
        lastReminderAt: orders.lastReminderAt,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (order.status !== 'AWAITING_PAYMENT' || order.method !== 'BANK_TRANSFER') {
      throw new DomainError(
        'REMINDER_NOT_APPLICABLE',
        'Only unpaid Vorkasse orders get reminders',
        409,
      );
    }
    if (
      order.lastReminderAt &&
      now.getTime() - order.lastReminderAt.getTime() < MANUAL_REMINDER_COOLDOWN_MS
    ) {
      return null;
    }
    const [claimed] = await tx
      .update(orders)
      .set({
        // Like the automatic dunning: the reminder is sent, so the scheduled one is consumed
        // (otherwise the dunning job would send a second reminder right after this one).
        nextReminderAt: null,
        lastReminderAt: now,
        reminderCount: sql`${orders.reminderCount} + 1`,
        version: sql`${orders.version} + 1`,
      })
      .where(eq(orders.id, params.orderId))
      .returning({ reminderCount: orders.reminderCount });
    await tx.insert(orderHistory).values({
      orderId: params.orderId,
      type: 'reminder_sent',
      actorType: 'ADMIN',
      actorUserId: params.userId,
      data: { reminderCount: claimed?.reminderCount ?? null, manual: true },
    });
    return createEmailMessage(ctx, tx, { key: 'PAYMENT_REMINDER', orderId: params.orderId });
  });
  if (!messageId) return 'RECENTLY_REMINDED';
  await dispatchEmailMessage(ctx, messageId).catch((err: unknown) =>
    coreLog.error({ err }, '[bulk] reminder stored but not queued (outbox retries)'),
  );
  return 'SENT';
}

export async function runBulkOrderAction(
  ctx: CoreContext,
  params: { action: BulkOrderAction; orderIds: string[]; userId: string },
): Promise<BulkOrderOutcome[]> {
  const ids = [...new Set(params.orderIds)].slice(0, BULK_ORDER_LIMIT);
  if (ids.length === 0) return [];
  const rows = await ctx.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      keepReserved: orders.keepReserved,
    })
    .from(orders)
    .where(inArray(orders.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: BulkOrderOutcome[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      out.push({ orderId: id, orderNumber: '', outcome: 'failed', code: 'ORDER_NOT_FOUND' });
      continue;
    }
    const base = { orderId: id, orderNumber: row.orderNumber };
    try {
      switch (params.action) {
        case 'remind': {
          const r = await sendPaymentReminderNow(ctx, { orderId: id, userId: params.userId });
          out.push(
            r === 'SENT'
              ? { ...base, outcome: 'done' }
              : { ...base, outcome: 'skipped', code: 'RECENTLY_REMINDED' },
          );
          break;
        }
        case 'keepReservedOn':
        case 'keepReservedOff': {
          const keep = params.action === 'keepReservedOn';
          if (row.keepReserved === keep) {
            out.push({ ...base, outcome: 'skipped', code: 'UNCHANGED' });
            break;
          }
          await setKeepReserved(ctx, { orderId: id, keep, userId: params.userId });
          out.push({ ...base, outcome: 'done' });
          break;
        }
        case 'resendTickets':
          await resendOrderTickets(ctx, { orderId: id, userId: params.userId });
          out.push({ ...base, outcome: 'done' });
          break;
        case 'cancelUnpaid': {
          if (row.status === 'CANCELLED' || row.status === 'EXPIRED') {
            out.push({ ...base, outcome: 'skipped', code: 'UNCHANGED' });
            break;
          }
          await adminCancelOrder(ctx, { orderId: id, notifyCustomer: true, userId: params.userId });
          out.push({ ...base, outcome: 'done' });
          break;
        }
      }
    } catch (err) {
      if (!(err instanceof DomainError))
        coreLog.error({ err, orderId: id }, '[bulk] action failed');
      out.push({
        ...base,
        outcome: 'failed',
        code: err instanceof DomainError ? err.code : 'INTERNAL_ERROR',
      });
    }
  }
  return out;
}
