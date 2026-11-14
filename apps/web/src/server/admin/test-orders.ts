'use server';

import {
  DomainError,
  cancelAndHideTestOrder,
  deleteTestOrder,
  deleteTestOrdersOfEvent,
} from '@tix/core';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import { type ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { logger } from '@/server/logger';
import { formError } from './form';

/**
 * Deleting / cancelling test orders (orders of super-admin test purchases on draft events).
 * SUPER_ADMIN only, re-checked here on every call. The core refuses to delete once real money was
 * captured (those orders are cancelled and hidden instead) and re-checks everything inside its
 * transaction; it also writes the audit entry.
 */

function refresh(): void {
  revalidatePath('/[locale]/admin/orders', 'layout');
  revalidatePath('/[locale]/admin/events', 'layout');
}

export async function deleteTestOrderAction(
  orderId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  if (!z.uuid().safeParse(orderId).success) return formError('notFound');
  try {
    const result = await deleteTestOrder(getCore(), { orderId, userId: session.userId });
    if (!result.deleted) {
      return formError(
        result.blocker === 'PAYMENT_OPEN'
          ? 'testOrderPaymentOpen'
          : result.blocker === 'INVOICE_EXISTS'
            ? 'testOrderInvoiceExists'
            : 'testOrderBlocked',
      );
    }
  } catch (err) {
    if (err instanceof DomainError) {
      return formError(err.code === 'ORDER_NOT_FOUND' ? 'notFound' : 'testOrderBlocked');
    }
    logger.error({ err }, '[admin/test-orders] delete failed');
    return formError('generic');
  }
  refresh();
  return redirect({ href: '/admin/orders', locale: await getLocale() });
}

export async function deleteEventTestOrdersAction(
  eventId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  if (!z.uuid().safeParse(eventId).success) return formError('notFound');
  try {
    const result = await deleteTestOrdersOfEvent(getCore(), { eventId, userId: session.userId });
    refresh();
    if (result.kept.length > 0) return formError('testOrdersKept');
  } catch (err) {
    logger.error({ err }, '[admin/test-orders] bulk delete failed');
    return formError('generic');
  }
  return { status: 'success', message: 'deleted', at: Date.now() };
}

/** Test order with real money: cancel it (refunds as usual) and hide it from the order list. */
export async function cancelHideTestOrderAction(
  orderId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  if (!z.uuid().safeParse(orderId).success) return formError('notFound');
  try {
    await cancelAndHideTestOrder(getCore(), { orderId, userId: session.userId });
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === 'ORDER_NOT_FOUND') return formError('notFound');
      if (err.code === 'TEST_ORDER_PARTIAL_PAYMENT') return formError('testOrderPartialPayment');
      return formError('testOrderCancelFailed');
    }
    logger.error({ err }, '[admin/test-orders] cancel & hide failed');
    return formError('generic');
  }
  refresh();
  return { status: 'success', message: 'saved', at: Date.now() };
}
