import { orderAdjustments, orderHistory, orders } from '@tix/db';
import type { EmailTemplateKey } from '@tix/shared';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { enqueueEmail } from '../email';
import { listOrderTickets } from '../tickets/issue';
import { completeAdjustment, type CompleteAdjustmentResult } from './adjustments';
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

/**
 * Payment of an additional payment (tariff change) received outside the automatic channels
 * (cash, transfer matched by hand …). The amount is always the adjustment amount.
 */
export async function recordManualAdjustmentPayment(
  ctx: CoreContext,
  params: {
    adjustmentId: string;
    method: 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'PAYPAL';
    note?: string | null;
    receivedAt?: Date;
    userId: string;
  },
): Promise<CompleteAdjustmentResult> {
  const [adjustment] = await ctx.db
    .select()
    .from(orderAdjustments)
    .where(eq(orderAdjustments.id, params.adjustmentId));
  if (!adjustment)
    throw new DomainError('ADJUSTMENT_NOT_FOUND', 'Additional payment not found', 404);
  const result = await completeAdjustment(ctx, {
    adjustmentId: adjustment.id,
    amount: adjustment.amount,
    currency: adjustment.currency,
    method: params.method,
    capturedAt: params.receivedAt,
    receivedByUserId: params.userId,
    providerResponse: params.note?.trim() ? { note: params.note.trim() } : null,
    actor: { type: 'ADMIN', userId: params.userId },
  });
  if (result.status === 'NOT_PAYABLE') {
    throw new DomainError('ADJUSTMENT_NOT_PAYABLE', 'This additional payment cannot be paid', 409, {
      reason: result.reason,
    });
  }
  return result;
}

/** E-mail matching the current state of the order. */
export function resendableEmail(status: string, method: string): EmailTemplateKey | null {
  if (status === 'AWAITING_PAYMENT' && method === 'BANK_TRANSFER') {
    return 'ORDER_CONFIRMATION_BANK_TRANSFER';
  }
  if (status === 'PAID' || status === 'PARTIALLY_REFUNDED') return 'PAYMENT_RECEIVED_TICKETS';
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

/** Sends the tickets (PDF attached) of a PAID order again (TICKETS_RESENT). */
export async function resendOrderTickets(
  ctx: CoreContext,
  params: { orderId: string; userId: string },
): Promise<void> {
  const order = await loadOrder(ctx, params.orderId);
  if (order.status !== 'PAID' && order.status !== 'PARTIALLY_REFUNDED') {
    throw new DomainError('ORDER_NOT_PAID', 'Tickets exist for paid orders only', 409);
  }
  const issued = await listOrderTickets(ctx, order.id);
  if (issued.length === 0) {
    throw new DomainError('NO_TICKETS', 'The order has no valid tickets yet', 409);
  }
  await enqueueEmail(ctx, { key: 'TICKETS_RESENT', orderId: order.id });
  await ctx.db.insert(orderHistory).values({
    orderId: order.id,
    type: 'tickets_resent',
    actorType: 'ADMIN',
    actorUserId: params.userId,
    data: { tickets: issued.length },
  });
}

export async function updateInternalNote(
  ctx: CoreContext,
  params: { orderId: string; note: string | null; userId: string },
): Promise<void> {
  const note = params.note?.trim() || null;
  await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(orders)
      .set({ internalNote: note, version: sql`${orders.version} + 1` })
      .where(eq(orders.id, params.orderId))
      .returning({ id: orders.id });
    if (updated.length === 0) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    await tx.insert(orderHistory).values({
      orderId: params.orderId,
      type: 'note_changed',
      actorType: 'ADMIN',
      actorUserId: params.userId,
      data: { note },
    });
  });
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
