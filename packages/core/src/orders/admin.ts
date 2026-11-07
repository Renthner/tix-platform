import { orderHistory, orders } from '@tix/db';
import type { EmailTemplateKey } from '@tix/shared';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { enqueueEmail } from '../email';
import { cancelOrder, recordPayment, type RecordPaymentResult } from './fulfillment';

/** Admin / customer actions on single orders (box office features follow in phase 5). */

async function loadOrder(ctx: CoreContext, orderId: string) {
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  return order;
}

/** "Keep reserved": the order is never cancelled automatically while set. */
export async function setKeepReserved(
  ctx: CoreContext,
  params: { orderId: string; keep: boolean; reason?: string | null; userId: string | null },
): Promise<void> {
  const order = await loadOrder(ctx, params.orderId);
  if (params.keep && order.status !== 'AWAITING_PAYMENT' && order.status !== 'PENDING') {
    throw new DomainError('ORDER_NOT_OPEN', 'Only unpaid orders can be kept reserved', 409);
  }
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({
        keepReserved: params.keep,
        keepReservedReason: params.keep ? params.reason?.trim() || null : null,
        keepReservedByUserId: params.keep ? params.userId : null,
        version: sql`${orders.version} + 1`,
      })
      .where(eq(orders.id, order.id));
    await tx.insert(orderHistory).values({
      orderId: order.id,
      type: 'keep_reserved_changed',
      actorType: 'ADMIN',
      actorUserId: params.userId,
      data: { keepReserved: params.keep, reason: params.reason?.trim() || null },
    });
  });
}

export async function adminCancelOrder(
  ctx: CoreContext,
  params: { orderId: string; reason?: string | null; notifyCustomer: boolean; userId: string },
): Promise<void> {
  const done = await cancelOrder(ctx, {
    orderId: params.orderId,
    status: 'CANCELLED',
    reason: params.reason?.trim() || 'CANCELLED_BY_ADMIN',
    actor: { type: 'ADMIN', userId: params.userId },
    notifyCustomer: params.notifyCustomer,
  });
  if (!done) {
    throw new DomainError(
      'ORDER_NOT_CANCELLABLE',
      'Only unpaid orders can be cancelled here – paid orders need a refund',
      409,
    );
  }
}

/** Payment received outside the automatic channels (bank transfer matched by hand, cash …). */
export async function recordManualPayment(
  ctx: CoreContext,
  params: {
    orderId: string;
    amount: number;
    method: 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'PAYPAL';
    note?: string | null;
    receivedAt?: Date;
    userId: string;
  },
): Promise<RecordPaymentResult> {
  const order = await loadOrder(ctx, params.orderId);
  const result = await recordPayment(ctx, {
    orderId: order.id,
    amount: params.amount,
    currency: order.currency,
    method: params.method,
    capturedAt: params.receivedAt,
    receivedByUserId: params.userId,
    providerResponse: params.note?.trim() ? { note: params.note.trim() } : null,
    actor: { type: 'ADMIN', userId: params.userId },
  });
  if (result.status === 'NOT_PAYABLE') {
    throw new DomainError('ORDER_NOT_PAYABLE', 'This order cannot receive payments', 409, {
      status: result.orderStatus,
    });
  }
  return result;
}

/** E-mail matching the current state of the order. */
export function resendableEmail(status: string, method: string): EmailTemplateKey | null {
  if (status === 'AWAITING_PAYMENT' && method === 'BANK_TRANSFER') {
    return 'ORDER_CONFIRMATION_BANK_TRANSFER';
  }
  if (status === 'PAID') return 'PAYMENT_RECEIVED_TICKETS';
  if (status === 'CANCELLED' || status === 'EXPIRED') return 'ORDER_CANCELLED';
  return null;
}

export async function resendOrderEmail(
  ctx: CoreContext,
  params: { orderId: string; userId: string },
): Promise<EmailTemplateKey> {
  const order = await loadOrder(ctx, params.orderId);
  const key = resendableEmail(order.status, order.paymentMethod);
  if (!key)
    throw new DomainError('NOTHING_TO_SEND', 'There is no e-mail for this order state', 409);
  await enqueueEmail(ctx, { key, orderId: order.id });
  await ctx.db.insert(orderHistory).values({
    orderId: order.id,
    type: 'email_resent',
    actorType: 'ADMIN',
    actorUserId: params.userId,
    data: { template: key },
  });
  return key;
}

export async function updateInternalNote(
  ctx: CoreContext,
  params: { orderId: string; note: string | null; userId: string },
): Promise<void> {
  const note = params.note?.trim() || null;
  const updated = await ctx.db
    .update(orders)
    .set({ internalNote: note, version: sql`${orders.version} + 1` })
    .where(eq(orders.id, params.orderId))
    .returning({ id: orders.id });
  if (updated.length === 0) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
}

/** The buyer abandons an unpaid PayPal order on the order page (seats are released). */
export async function cancelPendingOrderByCustomer(
  ctx: CoreContext,
  orderId: string,
): Promise<boolean> {
  const [order] = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(eq(orders.id, orderId), eq(orders.status, 'PENDING'), eq(orders.paymentMethod, 'PAYPAL')),
    );
  if (!order) return false;
  return cancelOrder(ctx, {
    orderId,
    status: 'CANCELLED',
    reason: 'CANCELLED_BY_CUSTOMER',
    actor: { type: 'CUSTOMER' },
  });
}
