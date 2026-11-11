'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { cancelAdjustmentAction, repairInvoiceAction } from '@/server/admin/adjustments';
import type { OrderActionState } from '@/server/admin/orders';
import {
  recordExistingRefundAction,
  resolveRestoreReviewAction,
  skipRefundReconciliationAction,
} from '@/server/admin/refunds';

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

/** "Reviewed" for a refund finding after a backup restore. */
export function ResolveRestoreReviewButton({ orderId }: { orderId: string }) {
  const t = useTranslations('orders.admin.refundsPage.restoreReview');
  const tFeedback = useTranslations('orders.admin.feedback');
  const tErr = useTranslations('orders.errors');
  const tCommon = useTranslations('common.errors');
  const [state, action] = useActionState(resolveRestoreReviewAction.bind(null, orderId), {
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
        {t('resolve')}
      </SubmitButton>
    </ActionForm>
  );
}

function useActionToasts(state: OrderActionState) {
  const tFeedback = useTranslations('orders.admin.feedback');
  const tErr = useTranslations('orders.errors');
  const tCommon = useTranslations('common.errors');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') toast.success(tFeedback(state.message as never));
    else if (tErr.has(state.code as never)) toast.error(tErr(state.code as never));
    else toast.error(tCommon('INTERNAL_ERROR'));
  }, [state, tFeedback, tErr, tCommon]);
}

/**
 * "Record existing PayPal refund" on a review entry: the money already left PayPal, so the chosen
 * tickets are cancelled with a SUCCEEDED refund row and nothing is sent to PayPal.
 */
export function RecordExistingRefundForm({
  orderId,
  defaultRefundId,
  items,
  money,
}: {
  orderId: string;
  defaultRefundId: string;
  items: { id: string; label: string; priceGross: number }[];
  /** Formats cents (done on the server side, passed as strings). */
  money: Record<string, string>;
}) {
  const t = useTranslations('orders.admin.refundsPage.restoreReview.record');
  const [state, action] = useActionState(recordExistingRefundAction.bind(null, orderId), {
    status: 'idle',
  } as OrderActionState);
  useActionToasts(state);
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{t('summary')}</summary>
      <ActionForm action={action} className="mt-3 space-y-3">
        <p className="text-muted-foreground">{t('hint')}</p>
        <label className="block space-y-1">
          <span className="font-medium">{t('refundId')}</span>
          <input
            name="providerRefundId"
            defaultValue={defaultRefundId}
            required
            className="w-full rounded-md border bg-background px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block space-y-1">
          <span className="font-medium">{t('mode')}</span>
          <select
            name="mode"
            defaultValue={items.length > 0 ? 'cancel' : 'overpayment'}
            className="w-full rounded-md border bg-background px-2 py-1"
          >
            <option value="cancel">{t('modeCancel')}</option>
            <option value="overpayment">{t('modeOverpayment')}</option>
          </select>
        </label>
        <fieldset className="space-y-1">
          <legend className="font-medium">{t('items')}</legend>
          {items.map((item) => (
            <label key={item.id} className="flex items-center gap-2">
              <input type="checkbox" name="orderItemIds" value={item.id} defaultChecked />
              <span className="flex-1">{item.label}</span>
              <span className="tabular-nums">{money[item.id]}</span>
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="refundFees" />
          <span>{t('fees')}</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="notify" />
          <span>{t('notify')}</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="confirmed" required />
          <span>{t('confirm')}</span>
        </label>
        <SubmitButton size="sm">{t('submit')}</SubmitButton>
      </ActionForm>
    </details>
  );
}

/** SUPER_ADMIN: stop waiting for the PayPal reconciliation after a restore. */
export function SkipReconciliationForm() {
  const t = useTranslations('orders.admin.refundsPage.reconcile');
  const [state, action] = useActionState(skipRefundReconciliationAction, {
    status: 'idle',
  } as OrderActionState);
  useActionToasts(state);
  return (
    <ActionForm action={action} className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" name="confirmed" required />
        <span>{t('skipConfirm')}</span>
      </label>
      <SubmitButton size="sm" variant="outline">
        {t('skip')}
      </SubmitButton>
    </ActionForm>
  );
}
