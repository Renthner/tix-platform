'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { CommunicationState } from '@/server/admin/communication';

export const COMMUNICATION_IDLE: CommunicationState = { status: 'idle' };

/** Toast for the result of a communication action (success message or translated error code). */
export function useCommunicationFeedback(state: CommunicationState) {
  const t = useTranslations('communication.feedback');
  const tErr = useTranslations('communication.errors');
  const tCommon = useTranslations('common.errors');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') {
      toast.success(t(state.message as never, (state.values ?? {}) as never));
    } else if (tErr.has(state.code as never)) {
      toast.error(tErr(state.code as never));
    } else if (tCommon.has(state.code as never)) {
      toast.error(tCommon(state.code as never));
    } else {
      toast.error(tCommon('INTERNAL_ERROR'));
    }
  }, [state, t, tErr, tCommon]);
}
