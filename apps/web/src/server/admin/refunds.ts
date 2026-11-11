'use server';

import {
  DomainError,
  completeManualRefund,
  completeRefundBatch,
  recordExistingPayPalOverpaymentRefund,
  recordExistingPayPalRefund,
  refundOverpayment,
  resolveRefundRestoreReview,
  skipRefundReconciliation,
  retryRefund,
  retryRefundBatch,
} from '@tix/core';
import { parseCancelPaidForm } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { text } from './form';
import type { OrderActionState } from './orders';

/** Admin actions on single refunds (order page + "Open refunds" list). */

const ok = (message: string): OrderActionState => ({ status: 'success', message, at: Date.now() });
const fail = (code: string): OrderActionState => ({ status: 'error', code, at: Date.now() });

async function run(refundId: string, fn: () => Promise<OrderActionState>) {
  if (!z.uuid().safeParse(refundId).success) return fail('REFUND_NOT_FOUND');
  try {
    const result = await fn();
    revalidatePath('/[locale]/admin/orders', 'layout');
    revalidatePath('/[locale]/admin/refunds', 'layout');
    revalidatePath('/[locale]/admin', 'layout');
    return result;
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code);
    console.error('[admin/refunds] action failed', err);
    return fail('INTERNAL_ERROR');
  }
}

export async function retryRefundAction(
  refundId: string,
  _prev: OrderActionState,
  _fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(refundId, async () => {
    const core = getCore();
    await retryRefund(core, refundId, session.userId);
    await audit(core.db, session, 'refund.retry', 'refund', refundId);
    return ok('refundRetried');
  });
}

export async function completeRefundAction(
  refundId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(refundId, async () => {
    if (fd.get('confirmed') !== 'on') return fail('VALIDATION_FAILED');
    const note = text(fd, 'note')?.slice(0, 500) ?? null;
    const core = getCore();
    const changed = await completeManualRefund(core, { refundId, userId: session.userId, note });
    await audit(core.db, session, 'refund.completed', 'refund', refundId, { note });
    return ok(changed ? 'refundCompleted' : 'refundAlreadyCompleted');
  });
}

/** "Als erstattet markieren" for a whole cancellation: all open manual rows at once. */
export async function completeRefundBatchAction(
  batchId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(batchId, async () => {
    if (fd.get('confirmed') !== 'on') return fail('VALIDATION_FAILED');
    const note = text(fd, 'note')?.slice(0, 500) ?? null;
    const core = getCore();
    const completed = await completeRefundBatch(core, { batchId, userId: session.userId, note });
    // One audit entry per refund row (the order history has one per row as well).
    for (const refundId of completed) {
      await audit(core.db, session, 'refund.completed', 'refund', refundId, { note, batchId });
    }
    return ok(completed.length > 0 ? 'refundCompleted' : 'refundAlreadyCompleted');
  });
}

/** Retries the failed PayPal rows of a cancellation. */
export async function retryRefundBatchAction(
  batchId: string,
  _prev: OrderActionState,
  _fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(batchId, async () => {
    const core = getCore();
    const retried = await retryRefundBatch(core, { batchId, userId: session.userId });
    for (const refundId of retried) {
      await audit(core.db, session, 'refund.retry', 'refund', refundId, { batchId });
    }
    return ok('refundRetried');
  });
}

/** "Überzahlung erstatten": refund of the excess money of a fully paid order. */
export async function refundOverpaymentAction(
  orderId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(orderId, async () => {
    if (fd.get('confirmed') !== 'on') return fail('VALIDATION_FAILED');
    const expectedAmount = Number(text(fd, 'expectedAmount'));
    if (!Number.isInteger(expectedAmount) || expectedAmount <= 0) return fail('VALIDATION_FAILED');
    const core = getCore();
    const result = await refundOverpayment(core, {
      orderId,
      userId: session.userId,
      expectedAmount,
    });
    await audit(core.db, session, 'order.overpayment_refund', 'order', orderId, {
      batchId: result.batchId,
      amount: result.amount,
    });
    return ok('overpaymentRefundRequested');
  });
}

/** "Reviewed" on a restore review entry of the "Open refunds" page (audited in the same transaction). */
export async function resolveRestoreReviewAction(
  orderId: string,
  _prev: OrderActionState,
  _fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  if (!z.uuid().safeParse(orderId).success) return fail('ORDER_NOT_FOUND');
  try {
    const core = getCore();
    await resolveRefundRestoreReview(core, {
      orderId,
      userId: session.userId,
      inTransaction: (tx) => audit(tx, session, 'refund.restore_review_resolved', 'order', orderId),
    });
    revalidatePath('/[locale]/admin/refunds', 'layout');
    return ok('restoreReviewResolved');
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code);
    console.error('[admin/refunds] review action failed', err);
    return fail('INTERNAL_ERROR');
  }
}

/**
 * "Record existing PayPal refund": the refund already left PayPal (lost window / PayPal dashboard).
 * Fields: `providerRefundId`, `orderItemIds` (tickets to cancel), `refundFees`, `notify`, `reason`,
 * `confirmed`. Verified against PayPal live; nothing is sent to PayPal.
 */
export async function recordExistingRefundAction(
  orderId: string,
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['FINANCE']);
  if (!z.uuid().safeParse(orderId).success) return fail('ORDER_NOT_FOUND');
  const providerRefundId = text(fd, 'providerRefundId');
  if (!providerRefundId || !/^[A-Za-z0-9_-]{5,64}$/.test(providerRefundId)) {
    return fail('VALIDATION_FAILED');
  }
  try {
    const core = getCore();
    if (fd.get('mode') === 'overpayment') {
      // The refund paid back an overpayment (no tickets): booked as an overpayment refund.
      if (fd.get('confirmed') !== 'on') return fail('VALIDATION_FAILED');
      await recordExistingPayPalOverpaymentRefund(core, {
        orderId,
        providerRefundId,
        userId: session.userId,
        inTransaction: (tx, result) =>
          audit(tx, session, 'refund.paypal_existing_recorded', 'order', orderId, {
            providerRefundId,
            overpayment: true,
            amount: result.amount,
          }),
      });
    } else {
      const input = parseCancelPaidForm(fd);
      if (!input) return fail('VALIDATION_FAILED');
      await recordExistingPayPalRefund(core, {
        orderId,
        providerRefundId,
        orderItemIds: input.orderItemIds,
        refundFees: input.refundFees,
        reason: input.reason,
        notify: input.notify,
        userId: session.userId,
        // The audit entry belongs to the business transaction (all or nothing).
        inTransaction: (tx, result) =>
          audit(tx, session, 'refund.paypal_existing_recorded', 'order', orderId, {
            providerRefundId,
            orderItemIds: input.orderItemIds,
            refundFees: input.refundFees,
            creditTotal: result.creditTotal,
            creditNote: result.creditNote?.number ?? null,
          }),
      });
    }
    revalidatePath('/[locale]/admin/orders', 'layout');
    revalidatePath('/[locale]/admin/refunds', 'layout');
    revalidatePath('/[locale]/admin', 'layout');
    return ok('existingRefundRecorded');
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code);
    console.error('[admin/refunds] record existing refund failed', err);
    return fail('INTERNAL_ERROR');
  }
}

/** SUPER_ADMIN override: stop waiting for the post-restore PayPal reconciliation (audited). */
export async function skipRefundReconciliationAction(
  _prev: OrderActionState,
  fd: FormData,
): Promise<OrderActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  if (fd.get('confirmed') !== 'on') return fail('VALIDATION_FAILED');
  try {
    const core = getCore();
    await skipRefundReconciliation(core, (tx) =>
      audit(tx, session, 'refund.reconciliation_skipped', 'refund_reconcile_state', null),
    );
    revalidatePath('/[locale]/admin/refunds', 'layout');
    revalidatePath('/[locale]/admin', 'layout');
    return ok('reconciliationSkipped');
  } catch (err) {
    console.error('[admin/refunds] skip reconciliation failed', err);
    return fail('INTERNAL_ERROR');
  }
}
