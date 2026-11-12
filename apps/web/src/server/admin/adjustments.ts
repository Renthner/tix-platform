'use server';

import { logger } from '@/server/logger';
import {
  DomainError,
  cancelAdjustment,
  proposeTariffChange,
  recordManualAdjustmentPayment,
  repairOrderInvoice,
} from '@tix/core';
import { orderAdjustments } from '@tix/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { flag, text } from './form';
import type { OrderActionState } from './orders';

/**
 * Admin actions for additional payments (tariff change of a paid order). Results carry stable
 * codes translated in the UI (`orders.admin.feedback.*` / `orders.errors.*`).
 */

const ok = (message: string, values?: Record<string, string>): OrderActionState => ({
  status: 'success',
  message,
  at: Date.now(),
  ...(values ? { values } : {}),
});
const fail = (code: string): OrderActionState => ({ status: 'error', code, at: Date.now() });

async function run(fn: () => Promise<OrderActionState>): Promise<OrderActionState> {
  try {
    const result = await fn();
    revalidatePath('/[locale]/admin/orders', 'layout');
    revalidatePath('/[locale]/admin/refunds', 'layout');
    revalidatePath('/[locale]/admin', 'layout');
    return result;
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code);
    logger.error({ err }, '[admin/adjustments] action failed');
    return fail('INTERNAL_ERROR');
  }
}

const CHANGE_PREFIX = 'change:';
const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CARD', 'PAYPAL'] as const;

/** "Tarif ändern": fields `change:<orderItemId>` = new ticket type id (empty = unchanged). */
export async function proposeTariffChangeAction(
  orderId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(async () => {
    if (!z.uuid().safeParse(orderId).success) return fail('ORDER_NOT_FOUND');
    const changes: { orderItemId: string; newTicketTypeId: string }[] = [];
    for (const [key, value] of fd.entries()) {
      if (!key.startsWith(CHANGE_PREFIX) || typeof value !== 'string' || value === '') continue;
      changes.push({ orderItemId: key.slice(CHANGE_PREFIX.length), newTicketTypeId: value });
    }
    const parsed = z
      .array(z.object({ orderItemId: z.uuid(), newTicketTypeId: z.uuid() }))
      .min(1)
      .max(100)
      .safeParse(changes);
    if (!parsed.success || fd.get('confirmed') !== 'on') return fail('VALIDATION_FAILED');
    const reason = text(fd, 'reason')?.slice(0, 500) ?? null;
    const notify = flag(fd, 'notify');
    const expectedVersion = Number(text(fd, 'version'));
    const core = getCore();
    const result = await proposeTariffChange(core, {
      orderId,
      changes: parsed.data,
      reason,
      notify,
      userId: session.userId,
      expectedVersion: Number.isInteger(expectedVersion) ? expectedVersion : undefined,
      // Customer money (an overpayment) may only be credited by finance.
      canUseCredit: hasRole(session, ['FINANCE']),
    });
    await audit(core.db, session, 'order.tariff_change_proposed', 'order', orderId, {
      adjustmentId: result.adjustmentId,
      amount: result.amount,
      difference: result.difference,
      creditApplied: result.creditApplied,
      settledByCredit: result.settledByCredit,
      reference: result.paymentReference,
      items: result.items,
      reason,
      notify,
    });
    if (result.settledByCredit) return ok('adjustmentSettledByCredit');
    return ok(result.emailQueued || !notify ? 'adjustmentProposed' : 'adjustmentProposedNoMail');
  });
}

/** Resets the tariff: cancels the open additional payment (nothing else needs undoing). */
export async function cancelAdjustmentAction(
  adjustmentId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(async () => {
    if (!z.uuid().safeParse(adjustmentId).success) return fail('ADJUSTMENT_NOT_FOUND');
    const reason = text(fd, 'reason')?.slice(0, 500) ?? null;
    const core = getCore();
    await cancelAdjustment(core, { adjustmentId, userId: session.userId, reason });
    await audit(
      core.db,
      session,
      'order.tariff_change_cancelled',
      'order_adjustment',
      adjustmentId,
      {
        reason,
      },
    );
    return ok('adjustmentCancelled');
  });
}

/** Payment of an open additional payment received outside the automatic channels. */
export async function recordAdjustmentPaymentAction(
  adjustmentId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(async () => {
    if (!z.uuid().safeParse(adjustmentId).success) return fail('ADJUSTMENT_NOT_FOUND');
    const method = z.enum(PAYMENT_METHODS).safeParse(text(fd, 'method'));
    if (!method.success) return fail('VALIDATION_FAILED');
    const receivedOn = text(fd, 'receivedOn');
    const receivedAt =
      receivedOn && /^\d{4}-\d{2}-\d{2}$/.test(receivedOn)
        ? new Date(`${receivedOn}T12:00:00Z`)
        : undefined;
    if (receivedAt && receivedAt.getTime() > Date.now() + 86_400_000) {
      return fail('VALIDATION_FAILED');
    }
    const note = text(fd, 'note')?.slice(0, 500) ?? null;
    const core = getCore();
    const [adjustment] = await core.db
      .select({ orderId: orderAdjustments.orderId, amount: orderAdjustments.amount })
      .from(orderAdjustments)
      .where(eq(orderAdjustments.id, adjustmentId));
    await recordManualAdjustmentPayment(core, {
      adjustmentId,
      method: method.data,
      note,
      receivedAt,
      userId: session.userId,
    });
    await audit(core.db, session, 'order.tariff_change_paid', 'order_adjustment', adjustmentId, {
      orderId: adjustment?.orderId,
      amount: adjustment?.amount,
      method: method.data,
      note,
    });
    return ok('adjustmentPaymentRecorded');
  });
}

/** "Rechnung korrigieren": credit note of the stale invoice + new invoice over the current order. */
export async function repairInvoiceAction(
  orderId: string,
  _prev: OrderActionState,
  _fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(async () => {
    if (!z.uuid().safeParse(orderId).success) return fail('ORDER_NOT_FOUND');
    const core = getCore();
    const result = await repairOrderInvoice(core, { orderId, userId: session.userId });
    await audit(core.db, session, 'order.invoice_repaired', 'order', orderId, result);
    return ok(result.repaired ? 'invoiceRepaired' : 'invoiceUpToDate');
  });
}
