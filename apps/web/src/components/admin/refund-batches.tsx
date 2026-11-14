'use client';

import { ChevronDown, Download } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { CopyIban, RefundActions } from '@/components/admin/refund-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import {
  completeRefundBatchAction,
  refundOverpaymentAction,
  retryRefundBatchAction,
} from '@/server/admin/refunds';
import type { OrderActionState } from '@/server/admin/orders';

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

export interface RefundBatchRowData {
  id: string;
  kind: 'AUTOMATIC' | 'MANUAL';
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  method: string;
  amount: number;
  payerIban: string | null;
  payerName: string | null;
  failureMessage: string | null;
  note: string | null;
  stuck: boolean;
}

export interface RefundBatchData {
  batchId: string;
  currency: string;
  totalAmount: number;
  openAmount: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  stuck: boolean;
  overpayment: boolean;
  reason: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  createdAt: Date;
  completedAt: Date | null;
  rows: RefundBatchRowData[];
  transfers: { payerIban: string | null; payerName: string | null; amount: number }[];
  canComplete: boolean;
  canRetry: boolean;
  /** Only on the "open refunds" page. */
  order?: { id: string; number: string; customer: string; email: string | null };
}

/**
 * One cancellation (batch) per row: one total, one credit note, the account(s) to pay back to and
 * the actions for the whole batch; the breakdown per payment opens below. Stacked on small screens.
 */
export function RefundBatchList({
  batches,
  canAct,
}: {
  batches: RefundBatchData[];
  canAct: boolean;
}) {
  return (
    <ul className="divide-y rounded-md border">
      {batches.map((b) => (
        <li key={b.batchId}>
          <RefundBatchItem batch={b} canAct={canAct} />
        </li>
      ))}
    </ul>
  );
}

function RefundBatchItem({ batch, canAct }: { batch: RefundBatchData; canAct: boolean }) {
  const t = useTranslations('orders.admin.refunds');
  const tMethod = useTranslations('orders.method');
  const format = useFormatter();
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: batch.currency });
  const date = (d: Date) => format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' });
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const statusKey = batch.stuck && batch.status === 'PENDING' ? 'STUCK' : batch.status;
  const automatic = batch.rows.filter((r) => r.kind === 'AUTOMATIC');
  const manual = batch.rows.filter((r) => r.kind === 'MANUAL');
  const sum = (rows: RefundBatchRowData[]) => rows.reduce((s, r) => s + r.amount, 0);
  const statusOf = (rows: RefundBatchRowData[]) =>
    rows.some((r) => r.status === 'FAILED')
      ? 'FAILED'
      : rows.some((r) => r.status === 'PENDING')
        ? 'PENDING'
        : 'SUCCEEDED';

  return (
    <div className="grid gap-x-4 gap-y-3 p-4 md:grid-cols-[minmax(9rem,12rem)_9rem_minmax(14rem,1fr)_minmax(14rem,auto)] md:items-start">
      <div className="min-w-0 space-y-0.5">
        {batch.order ? (
          <>
            <Link href={`/admin/orders/${batch.order.id}`} className="font-medium hover:underline">
              {batch.order.number}
            </Link>
            <div className="truncate">{batch.order.customer}</div>
            {batch.order.email && (
              <div className="truncate text-xs text-muted-foreground">{batch.order.email}</div>
            )}
          </>
        ) : (
          <div className="font-medium">
            {batch.overpayment ? t('overpaymentRefund') : t('cancellation')}
          </div>
        )}
        <div className="whitespace-nowrap text-xs text-muted-foreground">
          {date(batch.createdAt)}
        </div>
      </div>

      <div className="space-y-1 md:text-right">
        <div className="text-base font-semibold tabular-nums">{money(batch.totalAmount)}</div>
        {batch.openAmount !== batch.totalAmount && batch.openAmount > 0 && (
          <div className="text-xs text-muted-foreground tabular-nums">
            {t('stillOpen', { amount: money(batch.openAmount) })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1 md:justify-end">
          <Badge
            variant={
              batch.status === 'FAILED'
                ? 'destructive'
                : batch.status === 'SUCCEEDED'
                  ? 'default'
                  : 'secondary'
            }
          >
            {t(`statuses.${statusKey}`)}
          </Badge>
          {batch.overpayment && <Badge variant="outline">{t('overpaymentBadge')}</Badge>}
        </div>
      </div>

      <div className="min-w-0 space-y-2 text-sm">
        {batch.transfers.length > 0 ? (
          <ul className="space-y-1.5">
            {batch.transfers.map((tr, index) => (
              <li key={index} className="space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium tabular-nums">{money(tr.amount)}</span>
                  <span className="text-muted-foreground">{tr.payerName ?? '–'}</span>
                </div>
                {tr.payerIban && <CopyIban iban={tr.payerIban} />}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
        {batch.creditNoteId && (
          <a
            href={`/api/admin/invoices/${batch.creditNoteId}`}
            className="inline-flex items-center gap-1 text-xs hover:underline"
          >
            <Download className="size-3.5" /> {batch.creditNoteNumber}
          </a>
        )}
        {batch.reason && <div className="text-xs text-muted-foreground">{batch.reason}</div>}
        {batch.rows
          .filter((r) => r.failureMessage)
          .map((r) => (
            <div key={r.id} className="text-xs text-destructive">
              {r.failureMessage}
            </div>
          ))}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          {t('breakdown')}
        </button>
      </div>

      <div className="flex flex-col gap-2 md:items-end">
        {canAct && batch.canRetry && <RetryBatchButton batchId={batch.batchId} />}
        {canAct && batch.canComplete && <CompleteBatchForm batchId={batch.batchId} />}
      </div>

      {open && (
        <div id={detailsId} className="space-y-3 border-t pt-3 text-sm md:col-span-4">
          <ul className="space-y-1 text-muted-foreground">
            {automatic.length > 0 && (
              <li>
                {t('partPaypal', {
                  amount: money(sum(automatic)),
                  status: t(`statuses.${statusOf(automatic)}`),
                })}
              </li>
            )}
            {manual.length > 0 && (
              <li>
                {t('partTransfer', {
                  amount: money(sum(manual)),
                  status: t(`statuses.${statusOf(manual)}`),
                })}
              </li>
            )}
          </ul>
          <ul className="divide-y rounded-md border">
            {batch.rows.map((r) => {
              const canRetry = r.kind === 'AUTOMATIC' && r.status === 'FAILED';
              // A failed / stuck PayPal refund can be paid back by hand outside PayPal.
              const rowComplete =
                r.status !== 'SUCCEEDED' &&
                r.kind === 'AUTOMATIC' &&
                (r.status === 'FAILED' || r.stuck);
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <span>{t(`kinds.${r.kind}`)}</span>
                    <span className="text-muted-foreground"> · {tMethod(r.method as never)}</span>
                    {r.note && <div className="text-xs text-muted-foreground">{r.note}</div>}
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge
                      variant={
                        r.status === 'FAILED'
                          ? 'destructive'
                          : r.status === 'SUCCEEDED'
                            ? 'default'
                            : 'secondary'
                      }
                    >
                      {t(`statuses.${r.stuck ? 'STUCK' : r.status}`)}
                    </Badge>
                    <span className="tabular-nums">{money(r.amount)}</span>
                    {canAct && (canRetry || rowComplete) && (
                      <RefundActions
                        refundId={r.id}
                        canRetry={canRetry}
                        canComplete={rowComplete}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function RetryBatchButton({ batchId }: { batchId: string }) {
  const t = useTranslations('orders.admin.refunds');
  const [state, action] = useActionState(retryRefundBatchAction.bind(null, batchId), IDLE);
  useFeedback(state);
  return (
    <ActionForm action={action}>
      <SubmitButton size="sm" variant="outline">
        {t('retry')}
      </SubmitButton>
    </ActionForm>
  );
}

function CompleteBatchForm({ batchId }: { batchId: string }) {
  const t = useTranslations('orders.admin.refunds');
  const [state, action] = useActionState(completeRefundBatchAction.bind(null, batchId), IDLE);
  useFeedback(state);
  const id = useId();
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
    <ActionForm action={action} className="w-full space-y-2 text-left md:w-64">
      <Input name="note" maxLength={500} placeholder={t('note')} aria-label={t('note')} />
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          name="confirmed"
          checked={confirmed}
          onCheckedChange={(v) => setConfirmed(v === true)}
          className="mt-0.5"
        />
        <Label htmlFor={id} className="font-normal">
          {t('confirmDoneBatch')}
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

/** Order page: the order has been overpaid – refund the excess (PayPal automatic, else a to-do). */
export function OverpaymentCard({
  orderId,
  amount,
  currency,
  reserved,
  canRefund,
}: {
  orderId: string;
  /** Refundable excess (without the part an open tariff change reserves). */
  amount: number;
  currency: string;
  /** Part of the overpayment an open tariff change uses (0 = none). */
  reserved: number;

  canRefund: boolean;
}) {
  const t = useTranslations('orders.admin.overpayment');
  const format = useFormatter();
  const [state, action] = useActionState(refundOverpaymentAction.bind(null, orderId), IDLE);
  useFeedback(state);
  const id = useId();
  const [confirmed, setConfirmed] = useState(false);
  const money = format.number(amount / 100, { style: 'currency', currency });
  return (
    <div className="rounded-lg border border-warning-border bg-warning-soft p-4 text-sm text-warning">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t('title')}</h2>
        <span className="text-base font-semibold tabular-nums">{money}</span>
      </div>
      <p className="mt-1">{t('text', { amount: money })}</p>
      {reserved > 0 && (
        <p className="mt-2 text-xs">
          {t('reserved', {
            amount: format.number(reserved / 100, { style: 'currency', currency }),
          })}
        </p>
      )}
      {canRefund && (
        <ActionForm action={action} className="mt-3 space-y-2">
          <input type="hidden" name="expectedAmount" value={amount} />
          <div className="flex items-start gap-2">
            <Checkbox
              id={id}
              name="confirmed"
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
              className="mt-0.5"
            />
            <Label htmlFor={id} className="font-normal">
              {t('confirm', { amount: money })}
            </Label>
          </div>
          <SubmitButton size="sm" disabled={!confirmed}>
            {t('submit')}
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}
