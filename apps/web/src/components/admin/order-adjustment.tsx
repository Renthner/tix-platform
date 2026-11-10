'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  cancelAdjustmentAction,
  proposeTariffChangeAction,
  recordAdjustmentPaymentAction,
} from '@/server/admin/adjustments';
import type { OrderActionState } from '@/server/admin/orders';

const IDLE: OrderActionState = { status: 'idle' };

/** Toast for an action result (success message or translated error code). */
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

export interface AdjustmentCardItem {
  id: string;
  label: string;
  /** Current tariff and price, e.g. "Reduced · 25.00 €". */
  detail: string;
  /** Price paid for the ticket (cents). */
  paid: number;
  options: { id: string; name: string; priceGross: number }[];
}

export interface OpenAdjustmentProps {
  id: string;
  status: 'PROPOSED' | 'CONFIRMED';
  /** Cash still to pay. */
  amount: number;
  /** Overpayment of the order credited against the difference. */
  creditApplied: number;
  reference: string;
  reason: string | null;
  createdAt: string;
  confirmedAt: string | null;
  reminderSentAt: string | null;
  items: { from: string; to: string; fromPrice: number; toPrice: number }[];
}

export function OrderAdjustmentCard(props: {
  orderId: string;
  version: number;
  currency: string;
  hasEmail: boolean;
  /** FINANCE / EVENT_MANAGER may propose and cancel. */
  canManage: boolean;
  /** FINANCE may record the payment. */
  canRecordPayment: boolean;
  /** The order is PAID (the only state a tariff change is possible in). */
  proposable: boolean;
  /** Overpayment of the order (net money above the total) that can be credited / refunded. */
  credit: number;
  /** FINANCE may credit customer money (the overpayment) against a tariff change. */
  canUseCredit: boolean;
  items: AdjustmentCardItem[];
  open: OpenAdjustmentProps | null;
}) {
  if (props.open) return <OpenAdjustment {...props} open={props.open} />;
  if (!props.proposable || !props.canManage) return null;
  return <ProposeForm {...props} />;
}

function ProposeForm({
  orderId,
  version,
  currency,
  hasEmail,
  credit,
  canUseCredit,
  items,
}: {
  orderId: string;
  version: number;
  currency: string;
  hasEmail: boolean;
  credit: number;
  canUseCredit: boolean;
  items: AdjustmentCardItem[];
}) {
  const t = useTranslations('orders.admin.adjustment');
  const format = useFormatter();
  const [state, action] = useActionState(proposeTariffChangeAction.bind(null, orderId), IDLE);
  useFeedback(state);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });
  const anyPickedEarly = Object.values(picked).some(Boolean);
  const additional = items.reduce((sum, item) => {
    const choice = item.options.find((o) => o.id === picked[item.id]);
    return choice ? sum + choice.priceGross - item.paid : sum;
  }, 0);
  const creditUsed = Math.min(credit, additional);
  const rest = additional - creditUsed;
  // Settled completely by credit: the customer gets the new tickets, so the mail is not optional.
  const mailForced = anyPickedEarly && credit > 0 && rest === 0;
  const blockedCredit = credit > 0 && !canUseCredit;
  const selectable = items.filter((i) => i.options.length > 0);
  const anyPicked = Object.values(picked).some(Boolean);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {selectable.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noOptions')}</p>
        ) : (
          <ActionForm action={action} className="space-y-3">
            <input type="hidden" name="version" value={version} />
            {selectable.map((item) => (
              <div key={item.id} className="space-y-1.5">
                <Label htmlFor={`adj-${item.id}`} className="block leading-snug">
                  {item.label}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {item.detail}
                  </span>
                </Label>
                <select
                  id={`adj-${item.id}`}
                  name={`change:${item.id}`}
                  value={picked[item.id] ?? ''}
                  onChange={(e) => setPicked((p) => ({ ...p, [item.id]: e.target.value }))}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="">{t('keep')}</option>
                  {item.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} · {money(o.priceGross)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="adj-reason">{t('reason')}</Label>
              <Input id="adj-reason" name="reason" maxLength={500} placeholder={t('reasonHint')} />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="adj-notify"
                name="notify"
                defaultChecked={hasEmail}
                checked={mailForced && hasEmail ? true : undefined}
                disabled={!hasEmail || mailForced}
              />
              <Label htmlFor="adj-notify">
                {hasEmail ? (mailForced ? t('notifyForced') : t('notify')) : t('noEmail')}
              </Label>
            </div>
            {anyPicked && (
              <div className="space-y-0.5 rounded-md bg-muted px-3 py-2 text-sm">
                <p>{t('summary', { amount: money(additional) })}</p>
                {credit > 0 && (
                  <>
                    <p>{t('summaryCredit', { credit: money(creditUsed) })}</p>
                    <p className="font-medium">
                      {rest === 0
                        ? t('summaryNothingToPay')
                        : t('summaryRest', { amount: money(rest) })}
                    </p>
                  </>
                )}
              </div>
            )}
            <div className="flex items-start gap-2">
              <Checkbox
                id="adj-confirmed"
                name="confirmed"
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(v === true)}
              />
              <Label htmlFor="adj-confirmed" className="text-sm font-normal leading-snug">
                {t('confirm')}
              </Label>
            </div>
            {blockedCredit && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {t('creditFinanceOnly', { credit: money(credit) })}
              </p>
            )}
            <SubmitButton size="sm" disabled={!anyPicked || !confirmed || blockedCredit}>
              {t('submit')}
            </SubmitButton>
          </ActionForm>
        )}
      </CardContent>
    </Card>
  );
}

function OpenAdjustment({
  currency,
  canManage,
  canRecordPayment,
  open,
  credit: totalCredit,
}: {
  currency: string;
  canManage: boolean;
  canRecordPayment: boolean;
  open: OpenAdjustmentProps;
  credit: number;
}) {
  const t = useTranslations('orders.admin.adjustment');
  const tMethod = useTranslations('orders.method');
  // Overpayment beyond what this open request already uses.
  const credit = Math.max(0, totalCredit - open.creditApplied);
  const format = useFormatter();
  const [cancelState, cancelAction] = useActionState(
    cancelAdjustmentAction.bind(null, open.id),
    IDLE,
  );
  const [payState, payAction] = useActionState(
    recordAdjustmentPaymentAction.bind(null, open.id),
    IDLE,
  );
  useFeedback(cancelState);
  useFeedback(payState);
  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card className="border-amber-300 dark:border-amber-800">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t('openTitle')}
          <Badge variant="secondary">{t(`status.${open.status}`)}</Badge>
        </CardTitle>
        <CardDescription>{t('openDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {open.creditApplied > 0 && (
            <>
              <dt className="text-muted-foreground">{t('difference')}</dt>
              <dd className="tabular-nums">{money(open.amount + open.creditApplied)}</dd>
              <dt className="text-muted-foreground">{t('creditApplied')}</dt>
              <dd className="tabular-nums">−{money(open.creditApplied)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">
            {open.creditApplied > 0 ? t('rest') : t('amount')}
          </dt>
          <dd className="font-medium tabular-nums">{money(open.amount)}</dd>
          <dt className="text-muted-foreground">{t('reference')}</dt>
          <dd className="font-mono">{open.reference}</dd>
          <dt className="text-muted-foreground">{t('requested')}</dt>
          <dd>{date(open.createdAt)}</dd>
          {open.confirmedAt && (
            <>
              <dt className="text-muted-foreground">{t('confirmedAt')}</dt>
              <dd>{date(open.confirmedAt)}</dd>
            </>
          )}
          {open.reminderSentAt && (
            <>
              <dt className="text-muted-foreground">{t('reminderSent')}</dt>
              <dd>{date(open.reminderSentAt)}</dd>
            </>
          )}
          {open.reason && (
            <>
              <dt className="text-muted-foreground">{t('reasonLabel')}</dt>
              <dd>{open.reason}</dd>
            </>
          )}
        </dl>
        <ul className="space-y-1">
          {open.items.map((i, index) => (
            <li key={index} className="flex justify-between gap-2">
              <span>
                {i.from} → {i.to}
              </span>
              <span className="whitespace-nowrap tabular-nums">
                {money(i.fromPrice)} → {money(i.toPrice)}
              </span>
            </li>
          ))}
        </ul>
        {canRecordPayment && (
          <ActionForm action={payAction} className="space-y-2 border-t pt-3">
            <p className="font-medium">{t('record.title')}</p>
            {credit > 0 && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {t('record.overpaymentWarning', { amount: money(credit) })}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <select
                name="method"
                defaultValue="BANK_TRANSFER"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                aria-label={t('record.method')}
              >
                {(['BANK_TRANSFER', 'CASH', 'CARD', 'PAYPAL'] as const).map((m) => (
                  <option key={m} value={m}>
                    {tMethod(m)}
                  </option>
                ))}
              </select>
              <Input
                name="receivedOn"
                type="date"
                defaultValue={today}
                max={today}
                aria-label={t('record.date')}
              />
            </div>
            <Input name="note" maxLength={500} placeholder={t('record.note')} />
            <SubmitButton size="sm">
              {t('record.submit', { amount: money(open.amount) })}
            </SubmitButton>
          </ActionForm>
        )}
        {canManage && (
          <ActionForm action={cancelAction} className="space-y-2 border-t pt-3">
            <p className="font-medium">{t('cancel.title')}</p>
            <p className="text-xs text-muted-foreground">{t('cancel.description')}</p>
            <Input name="reason" maxLength={500} placeholder={t('cancel.reason')} />
            <SubmitButton size="sm" variant="outline">
              {t('cancel.submit')}
            </SubmitButton>
          </ActionForm>
        )}
      </CardContent>
    </Card>
  );
}
