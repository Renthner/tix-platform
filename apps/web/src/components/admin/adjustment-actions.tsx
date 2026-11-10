'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { cancelAdjustmentAction, repairInvoiceAction } from '@/server/admin/adjustments';
import type { OrderActionState } from '@/server/admin/orders';

/** "Reset tariff": cancels an open additional payment from the to-do list. */
export function ResetTariffButton({ adjustmentId }: { adjustmentId: string }) {
  const t = useTranslations('orders.admin.adjustmentsPage');
  const tFeedback = useTranslations('orders.admin.feedback');
  const tErr = useTranslations('orders.errors');
  const tCommon = useTranslations('common.errors');
  const [state, action] = useActionState(cancelAdjustmentAction.bind(null, adjustmentId), {
    status: 'idle',
  } as OrderActionState);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') toast.success(tFeedback(state.message as never));
    else if (tErr.has(state.code as never)) toast.error(tErr(state.code as never));
    else toast.error(tCommon('INTERNAL_ERROR'));
  }, [state, tFeedback, tErr, tCommon]);
  return (
    <ActionForm action={action}>
      <SubmitButton size="sm" variant="outline">
        {t('reset')}
      </SubmitButton>
    </ActionForm>
  );
}

/** "Rechnung korrigieren" from the to-do list. */
export function RepairInvoiceButton({ orderId }: { orderId: string }) {
  const t = useTranslations('orders.admin.adjustmentsPage');
  const tFeedback = useTranslations('orders.admin.feedback');
  const tErr = useTranslations('orders.errors');
  const tCommon = useTranslations('common.errors');
  const [state, action] = useActionState(repairInvoiceAction.bind(null, orderId), {
    status: 'idle',
  } as OrderActionState);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') toast.success(tFeedback(state.message as never));
    else if (tErr.has(state.code as never)) toast.error(tErr(state.code as never));
    else toast.error(tCommon('INTERNAL_ERROR'));
  }, [state, tFeedback, tErr, tCommon]);
  return (
    <ActionForm action={action}>
      <SubmitButton size="sm">{t('repairInvoice')}</SubmitButton>
    </ActionForm>
  );
}
