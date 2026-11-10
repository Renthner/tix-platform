'use server';

import {
  DomainError,
  adminCancelOrder,
  cancelPaidOrder,
  recordManualPayment,
  resendOrderEmail,
  resendOrderTickets,
  setKeepReserved,
  updateInternalNote,
} from '@tix/core';
import { orders } from '@tix/db';
import { parseCancelPaidForm } from '@tix/shared';
import { eq } from 'drizzle-orm';
import { getFormatter } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { parseMoneyToCents } from '@/lib/money';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { flag, text } from './form';

/**
 * Admin actions on single orders. Results carry stable codes translated in the UI
 * (`orders.admin.feedback.*` / `common.errors.*`).
 */
export type OrderActionState =
  | { status: 'idle' }
  | { status: 'success'; message: string; at: number; values?: Record<string, string> }
  | { status: 'error'; code: string; at: number };

const ok = (message: string, values?: Record<string, string>): OrderActionState => ({
  status: 'success',
  message,
  at: Date.now(),
  ...(values ? { values } : {}),
});
const fail = (code: string): OrderActionState => ({ status: 'error', code, at: Date.now() });

async function run(
  orderId: string,
  fn: () => Promise<OrderActionState>,
): Promise<OrderActionState> {
  if (!z.uuid().safeParse(orderId).success) return fail('ORDER_NOT_FOUND');
  try {
    const result = await fn();
    revalidatePath('/[locale]/admin/orders', 'layout');
    revalidatePath('/[locale]/admin/refunds', 'layout');
    return result;
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code);
    console.error('[admin/orders] action failed', err);
    return fail('INTERNAL_ERROR');
  }
}

export async function keepReservedAction(
  orderId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(orderId, async () => {
    const keep = flag(fd, 'keep');
    const reason = text(fd, 'reason')?.slice(0, 500) ?? null;
    const core = getCore();
    await setKeepReserved(core, { orderId, keep, reason, userId: session.userId });
    await audit(core.db, session, 'order.keep_reserved', 'order', orderId, { keep, reason });
    return ok(keep ? 'keepReservedOn' : 'keepReservedOff');
  });
}

export async function cancelOrderAction(
  orderId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(orderId, async () => {
    const reason = text(fd, 'reason')?.slice(0, 500) ?? null;
    const notifyCustomer = flag(fd, 'notify');
    const core = getCore();
    await adminCancelOrder(core, { orderId, reason, notifyCustomer, userId: session.userId });
    await audit(core.db, session, 'order.cancel', 'order', orderId, { reason, notifyCustomer });
    return ok('cancelled');
  });
}

/** Cancels items of a PAID order (whole order or single tickets) with refund + credit note. */
export async function cancelPaidOrderAction(
  orderId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(orderId, async () => {
    const input = parseCancelPaidForm(fd);
    if (!input) return fail('VALIDATION_FAILED');
    const core = getCore();
    const result = await cancelPaidOrder(core, {
      orderId,
      orderItemIds: input.orderItemIds,
      refundFees: input.refundFees,
      reason: input.reason,
      notify: input.notify,
      userId: session.userId,
      expectedVersion: input.expectedVersion,
    });
    await audit(core.db, session, 'order.paid_cancelled', 'order', orderId, {
      orderItemIds: input.orderItemIds,
      refundFees: input.refundFees,
      notify: input.notify,
      reason: input.reason,
      creditTotal: result.creditTotal,
      refundTotal: result.refundTotal,
      creditNote: result.creditNote?.number ?? null,
    });
    const format = await getFormatter();
    const [order] = await core.db
      .select({ currency: orders.currency })
      .from(orders)
      .where(eq(orders.id, orderId));
    const amount = format.number(result.refundTotal / 100, {
      style: 'currency',
      currency: order?.currency ?? 'EUR',
    });
    const automatic = result.refunds.some((r) => r.kind === 'AUTOMATIC');
    const manual = result.refunds.some((r) => r.kind === 'MANUAL');
    const key =
      result.refundTotal === 0
        ? 'paidCancelledNoRefund'
        : automatic && manual
          ? 'paidCancelledMixed'
          : automatic
            ? 'paidCancelledAutomatic'
            : 'paidCancelledManual';
    return ok(key, { amount, count: String(result.cancelledItems) });
  });
}

const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CARD', 'PAYPAL'] as const;

export async function recordPaymentAction(
  orderId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(orderId, async () => {
    const amount = parseMoneyToCents(text(fd, 'amount'));
    if (amount === null || amount <= 0) return fail('INVALID_AMOUNT');
    const method = z.enum(PAYMENT_METHODS).safeParse(text(fd, 'method'));
    if (!method.success) return fail('VALIDATION_FAILED');
    const receivedOn = text(fd, 'receivedOn');
    const receivedAt =
      receivedOn && /^\d{4}-\d{2}-\d{2}$/.test(receivedOn)
        ? new Date(`${receivedOn}T12:00:00Z`)
        : undefined;
    if (receivedAt && receivedAt.getTime() > Date.now() + 86_400_000)
      return fail('VALIDATION_FAILED');
    const note = text(fd, 'note')?.slice(0, 500) ?? null;
    const core = getCore();
    const result = await recordManualPayment(core, {
      orderId,
      amount,
      method: method.data,
      note,
      receivedAt,
      userId: session.userId,
    });
    await audit(core.db, session, 'order.payment_recorded', 'order', orderId, {
      amount,
      method: method.data,
      note,
      result: result.status,
    });
    return ok(result.status === 'PARTIAL' ? 'paymentPartial' : 'paymentRecorded');
  });
}

export async function resendEmailAction(
  orderId: string,
  _prev: OrderActionState,
  _fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(orderId, async () => {
    const core = getCore();
    const key = await resendOrderEmail(core, { orderId, userId: session.userId });
    await audit(core.db, session, 'order.email_resent', 'order', orderId, { template: key });
    return ok('emailQueued');
  });
}

export async function resendTicketsAction(
  orderId: string,
  _prev: OrderActionState,
  _fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(orderId, async () => {
    const core = getCore();
    await resendOrderTickets(core, { orderId, userId: session.userId });
    await audit(core.db, session, 'order.tickets_resent', 'order', orderId, {});
    return ok('ticketsQueued');
  });
}

export async function internalNoteAction(
  orderId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(orderId, async () => {
    const note = text(fd, 'note')?.slice(0, 4_000) ?? null;
    const core = getCore();
    await updateInternalNote(core, { orderId, note, userId: session.userId });
    await audit(core.db, session, 'order.note', 'order', orderId);
    return ok('noteSaved');
  });
}
