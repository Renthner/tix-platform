'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { OrderActionState } from '@/server/admin/orders';
import { useReportActionPending } from './action-dialog-pending';

export const ORDER_IDLE: OrderActionState = { status: 'idle' };

/** The parts of a next-intl translator used for error codes. */
export interface ErrorTranslator {
  (key: never): string;
  has(key: never): boolean;
}

/** Toasts the translated error code of a failed order action. */
function toastOrderError(code: string, tOrderErr: ErrorTranslator, tErr: ErrorTranslator) {
  if (tOrderErr.has(code as never)) toast.error(tOrderErr(code as never));
  else if (tErr.has(code as never)) toast.error(tErr(code as never));
  else toast.error(tErr('INTERNAL_ERROR' as never));
}

/** Toast for an order action result (success message or translated error code). */
export function useOrderFeedback(state: OrderActionState, silentSuccess = false) {
  const t = useTranslations('orders.admin.feedback');
  const tErr = useTranslations('common.errors');
  const tOrderErr = useTranslations('orders.errors');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') {
      if (!silentSuccess) toast.success(t(state.message as never, state.values as never));
    } else toastOrderError(state.code, tOrderErr, tErr);
  }, [state, t, tErr, tOrderErr, silentSuccess]);
}

/**
 * `useActionState` for an order action inside a dialog: the result is toasted right in the action
 * callback and `onSuccess` runs (e.g. closes the dialog) – a revalidation that unmounts the form
 * (status change) cannot swallow the feedback. While the request runs, the pending flag is
 * reported to a surrounding dialog host (`ActionPendingContext`), which then refuses to close.
 */
export function useClosingOrderAction(
  bound: (prev: OrderActionState, formData: FormData) => Promise<OrderActionState>,
  onSuccess?: () => void,
) {
  const t = useTranslations('orders.admin.feedback');
  const tErr = useTranslations('common.errors');
  const tOrderErr = useTranslations('orders.errors');
  const [state, action, isPending] = useActionState(
    async (prev: OrderActionState, formData: FormData) => {
      const result = await bound(prev, formData);
      if (result.status === 'success') {
        toast.success(t(result.message as never, result.values as never));
        onSuccess?.();
      } else if (result.status === 'error') {
        toastOrderError(result.code, tOrderErr, tErr);
      }
      return result;
    },
    ORDER_IDLE,
  );
  useReportActionPending(isPending);
  return [state, action, isPending] as const;
}
