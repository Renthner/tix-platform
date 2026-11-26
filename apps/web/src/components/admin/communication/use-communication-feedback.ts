'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { CommunicationState } from '@/server/admin/communication';
import { useReportActionPending } from '../action-dialog-pending';
import type { ErrorTranslator } from '../order-action-state';

export const COMMUNICATION_IDLE: CommunicationState = { status: 'idle' };

/** Toasts the translated error code of a failed communication action. */
function toastCommunicationError(code: string, tErr: ErrorTranslator, tCommon: ErrorTranslator) {
  if (tErr.has(code as never)) toast.error(tErr(code as never));
  else if (tCommon.has(code as never)) toast.error(tCommon(code as never));
  else toast.error(tCommon('INTERNAL_ERROR' as never));
}

/**
 * `useActionState` for a communication action inside a dialog: the result is toasted right in the
 * action callback (so it survives an unmounted form) and on success `onSuccess` runs (e.g. closes
 * the dialog). While the request runs, the pending flag is reported to a surrounding dialog host
 * (`ActionPendingContext`), which then refuses to close.
 */
export function useClosingCommunicationAction(
  bound: (prev: CommunicationState, formData: FormData) => Promise<CommunicationState>,
  onSuccess?: () => void,
) {
  const t = useTranslations('communication.feedback');
  const tErr = useTranslations('communication.errors');
  const tCommon = useTranslations('common.errors');
  const [state, action, isPending] = useActionState(
    async (prev: CommunicationState, formData: FormData) => {
      const result = await bound(prev, formData);
      if (result.status === 'success') {
        toast.success(t(result.message as never, (result.values ?? {}) as never));
        onSuccess?.();
      } else if (result.status === 'error') {
        toastCommunicationError(result.code, tErr, tCommon);
      }
      return result;
    },
    COMMUNICATION_IDLE,
  );
  useReportActionPending(isPending);
  return [state, action, isPending] as const;
}

/** Toast for the result of a communication action (success message or translated error code). */
export function useCommunicationFeedback(state: CommunicationState, silentSuccess = false) {
  const t = useTranslations('communication.feedback');
  const tErr = useTranslations('communication.errors');
  const tCommon = useTranslations('common.errors');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') {
      if (!silentSuccess) toast.success(t(state.message as never, (state.values ?? {}) as never));
    } else toastCommunicationError(state.code, tErr, tCommon);
  }, [state, t, tErr, tCommon, silentSuccess]);
}
