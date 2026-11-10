'use client';

import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OrderActionState } from '@/server/admin/orders';
import { completeRefundAction, retryRefundAction } from '@/server/admin/refunds';

const IDLE: OrderActionState = { status: 'idle' };

function useFeedback(state: OrderActionState) {
  const t = useTranslations('orders.admin.feedback');
  const tErr = useTranslations('common.errors');
  const tOrderErr = useTranslations('orders.errors');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') toast.success(t(state.message as never));
    else if (tOrderErr.has(state.code as never)) toast.error(tOrderErr(state.code as never));
    else if (tErr.has(state.code as never)) toast.error(tErr(state.code as never));
    else toast.error(tErr('INTERNAL_ERROR'));
  }, [state, t, tErr, tOrderErr]);
}

/** Retry (failed PayPal refund) and "mark as refunded" (manual / failed / stuck) for one refund. */
export function RefundActions({
  refundId,
  canRetry,
  canComplete,
}: {
  refundId: string;
  canRetry: boolean;
  canComplete: boolean;
}) {
  return (
    <div className="flex flex-col items-end gap-2">
      {canRetry && <RetryButton refundId={refundId} />}
      {canComplete && <CompleteForm refundId={refundId} />}
    </div>
  );
}

function RetryButton({ refundId }: { refundId: string }) {
  const t = useTranslations('orders.admin.refunds');
  const [state, action] = useActionState(retryRefundAction.bind(null, refundId), IDLE);
  useFeedback(state);
  return (
    <ActionForm action={action}>
      <SubmitButton size="sm" variant="outline">
        {t('retry')}
      </SubmitButton>
    </ActionForm>
  );
}

function CompleteForm({ refundId }: { refundId: string }) {
  const t = useTranslations('orders.admin.refunds');
  const [state, action] = useActionState(completeRefundAction.bind(null, refundId), IDLE);
  useFeedback(state);
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t('markDone')}
      </Button>
    );
  }
  return (
    <ActionForm action={action} className="w-64 space-y-2 text-left">
      <Input name="note" maxLength={500} placeholder={t('note')} aria-label={t('note')} />
      <div className="flex items-start gap-2">
        <Checkbox
          id={`refund-confirm-${refundId}`}
          name="confirmed"
          checked={confirmed}
          onCheckedChange={(v) => setConfirmed(v === true)}
          className="mt-0.5"
        />
        <Label htmlFor={`refund-confirm-${refundId}`} className="font-normal">
          {t('confirmDone')}
        </Label>
      </div>
      <div className="flex gap-2">
        <SubmitButton size="sm" disabled={!confirmed}>
          {t('markDoneSubmit')}
        </SubmitButton>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
    </ActionForm>
  );
}

/** IBAN in groups of four with a copy button (copies the compact form). */
export function CopyIban({ iban }: { iban: string }) {
  const t = useTranslations('orders.admin.refunds');
  const [copied, setCopied] = useState(false);
  const compact = iban.replace(/\s+/g, '');
  return (
    <span className="inline-flex items-center gap-1">
      <span className="whitespace-nowrap font-mono text-xs">
        {compact.replace(/(.{4})(?=.)/g, '$1 ')}
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label={t('copyIban')}
        onClick={() => {
          void navigator.clipboard.writeText(compact).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </span>
  );
}
