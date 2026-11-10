'use client';

import type { OrderStatus } from '@tix/shared';
import { useFormatter, useTranslations } from 'next-intl';
import { CheckCircle2 } from 'lucide-react';
import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { centsToInput } from '@/lib/money';
import {
  cancelOrderAction,
  cancelPaidOrderAction,
  internalNoteAction,
  keepReservedAction,
  recordPaymentAction,
  resendEmailAction,
  resendTicketsAction,
  type OrderActionState,
} from '@/server/admin/orders';

const IDLE: OrderActionState = { status: 'idle' };

/** Toast for an action result (success message or translated error code). */
function useFeedback(state: OrderActionState, silentSuccess = false) {
  const t = useTranslations('orders.admin.feedback');
  const tErr = useTranslations('common.errors');
  const tOrderErr = useTranslations('orders.errors');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') {
      if (!silentSuccess) toast.success(t(state.message as never, state.values as never));
    } else if (tOrderErr.has(state.code as never)) toast.error(tOrderErr(state.code as never));
    else if (tErr.has(state.code as never)) toast.error(tErr(state.code as never));
    else toast.error(tErr('INTERNAL_ERROR'));
  }, [state, t, tErr, tOrderErr, silentSuccess]);
}

type NoticeSlot = 'payment' | 'cancel' | 'paidCancel';
type OnDone = (slot: NoticeSlot, text: string) => void;

/**
 * Like `useActionState`, but reports a successful result to the parent (which stays mounted when
 * a revalidation removes this card), so the feedback is not lost with the card.
 */
function useNoticeAction(
  bound: (prev: OrderActionState, formData: FormData) => Promise<OrderActionState>,
  slot: NoticeSlot,
  onDone: OnDone,
) {
  const tFeedback = useTranslations('orders.admin.feedback');
  const [state, action] = useActionState(async (prev: OrderActionState, formData: FormData) => {
    const result = await bound(prev, formData);
    if (result.status === 'success') {
      onDone(slot, tFeedback(result.message as never, result.values as never));
    }
    return result;
  }, IDLE);
  useFeedback(state, true);
  return [state, action] as const;
}

const NOTICE_VISIBLE_MS = 3500;
const NOTICE_FADE_MS = 700;

/** Inline success message shown in place of a card; fades out and then calls `onGone`. */
function SuccessNotice({ text, onGone }: { text: string; onGone: () => void }) {
  const [fading, setFading] = useState(false);
  useEffect(() => {
    const fade = setTimeout(() => setFading(true), NOTICE_VISIBLE_MS);
    const gone = setTimeout(onGone, NOTICE_VISIBLE_MS + NOTICE_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [onGone]);
  return (
    <Card
      role="status"
      className={`border-emerald-300 bg-emerald-50 text-emerald-900 transition-opacity ease-out dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100 ${
        fading ? 'opacity-0' : 'opacity-100'
      }`}
      style={{ transitionDuration: `${NOTICE_FADE_MS}ms` }}
    >
      <CardContent className="flex items-center gap-2 py-4 text-sm font-medium">
        <CheckCircle2 className="size-5 shrink-0" /> {text}
      </CardContent>
    </Card>
  );
}

export function OrderAdminActions(props: {
  orderId: string;
  status: OrderStatus;
  keepReserved: boolean;
  keepReservedReason: string | null;
  outstanding: number;
  currency: string;
  internalNote: string | null;
  canRecordPayment: boolean;
  canResend: boolean;
  /** Cancel-and-refund card (FINANCE / SUPER_ADMIN only); null hides it. */
  paidCancel: PaidCancelProps | null;
}) {
  const open = props.status === 'PENDING' || props.status === 'AWAITING_PAYMENT';
  // Lives here (not in the cards) so a revalidation that unmounts a card keeps its feedback.
  const [notice, setNotice] = useState<{ slot: NoticeSlot; text: string; id: number } | null>(null);
  const onDone = useCallback<OnDone>((slot, text) => setNotice({ slot, text, id: Date.now() }), []);
  const clearNotice = useCallback(() => setNotice(null), []);
  const noticeFor = (slot: NoticeSlot) =>
    notice?.slot === slot ? (
      <SuccessNotice key={notice.id} text={notice.text} onGone={clearNotice} />
    ) : null;
  return (
    <>
      {open && props.status === 'AWAITING_PAYMENT' && <KeepReservedCard {...props} />}
      {noticeFor('payment') ??
        (props.canRecordPayment && (open || (props.status === 'PAID' && props.outstanding > 0)) && (
          <PaymentCard {...props} onDone={onDone} />
        ))}
      {noticeFor('cancel') ?? (open && <CancelCard orderId={props.orderId} onDone={onDone} />)}
      {noticeFor('paidCancel') ??
        // The paid-order cards wait until the "payment recorded" message has faded out.
        (notice?.slot !== 'payment' &&
          props.paidCancel &&
          (props.status === 'PAID' || props.status === 'PARTIALLY_REFUNDED') && (
            <PaidCancelCard orderId={props.orderId} {...props.paidCancel} onDone={onDone} />
          ))}
      {(open || props.status === 'PAID' || props.status === 'PARTIALLY_REFUNDED') && (
        <ChangeSeatsCard orderId={props.orderId} />
      )}
      {props.canResend && <ResendCard orderId={props.orderId} />}
      {(props.status === 'PAID' || props.status === 'PARTIALLY_REFUNDED') && (
        <ResendTicketsCard orderId={props.orderId} />
      )}
      <NoteCard orderId={props.orderId} note={props.internalNote} />
    </>
  );
}

function KeepReservedCard({
  orderId,
  keepReserved,
  keepReservedReason,
}: {
  orderId: string;
  keepReserved: boolean;
  keepReservedReason: string | null;
}) {
  const t = useTranslations('orders.admin.actions.keepReserved');
  const [state, action] = useActionState(keepReservedAction.bind(null, orderId), IDLE);
  useFeedback(state);
  const [keep, setKeep] = useState(keepReserved);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ActionForm action={action} className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch id="keep" name="keep" checked={keep} onCheckedChange={setKeep} />
            <Label htmlFor="keep">{t('label')}</Label>
          </div>
          {keep && (
            <Input
              name="reason"
              defaultValue={keepReservedReason ?? ''}
              maxLength={500}
              placeholder={t('reason')}
            />
          )}
          <SubmitButton size="sm">{t('save')}</SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

function PaymentCard({
  orderId,
  outstanding,
  currency,
  onDone,
}: {
  orderId: string;
  outstanding: number;
  currency: string;
  onDone: OnDone;
}) {
  const t = useTranslations('orders.admin.actions.payment');
  const tMethod = useTranslations('orders.method');
  const [, action] = useNoticeAction(recordPaymentAction.bind(null, orderId), 'payment', onDone);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ActionForm action={action} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">
                {t('amount')} ({currency})
              </Label>
              <Input
                id="pay-amount"
                name="amount"
                inputMode="decimal"
                defaultValue={outstanding > 0 ? centsToInput(outstanding) : ''}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">{t('date')}</Label>
              <Input id="pay-date" name="receivedOn" type="date" defaultValue={today} max={today} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-method">{t('method')}</Label>
            <select
              id="pay-method"
              name="method"
              defaultValue="BANK_TRANSFER"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {(['BANK_TRANSFER', 'CASH', 'CARD', 'PAYPAL'] as const).map((m) => (
                <option key={m} value={m}>
                  {tMethod(m)}
                </option>
              ))}
            </select>
          </div>
          <Input name="note" maxLength={500} placeholder={t('note')} />
          <SubmitButton size="sm">{t('submit')}</SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

function CancelCard({ orderId, onDone }: { orderId: string; onDone: OnDone }) {
  const t = useTranslations('orders.admin.actions.cancel');
  const [, action] = useNoticeAction(cancelOrderAction.bind(null, orderId), 'cancel', onDone);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ActionForm action={action} className="space-y-3">
          <Textarea name="reason" rows={2} maxLength={500} placeholder={t('reason')} />
          <div className="flex items-center gap-2">
            <Checkbox id="cancel-notify" name="notify" defaultChecked />
            <Label htmlFor="cancel-notify" className="font-normal">
              {t('notify')}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="cancel-confirm"
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
            />
            <Label htmlFor="cancel-confirm" className="font-normal">
              {t('confirm')}
            </Label>
          </div>
          <SubmitButton size="sm" variant="destructive" disabled={!confirmed}>
            {t('submit')}
          </SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

export interface PaidCancelProps {
  version: number;
  currency: string;
  refundFeesDefault: boolean;
  /** Active (CONFIRMED) items that can still be cancelled. */
  items: { id: string; label: string; detail: string; price: number }[];
}

function PaidCancelCard({
  orderId,
  version,
  currency,
  refundFeesDefault,
  items,
  onDone,
}: { orderId: string; onDone: OnDone } & PaidCancelProps) {
  const t = useTranslations('orders.admin.actions.cancelPaid');
  const format = useFormatter();
  const [, action] = useNoticeAction(
    cancelPaidOrderAction.bind(null, orderId),
    'paidCancel',
    onDone,
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmed, setConfirmed] = useState(false);
  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });
  const sum = items.filter((i) => selected.has(i.id)).reduce((total, i) => total + i.price, 0);
  const allSelected = items.length > 0 && selected.size === items.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noActiveItems')}</p>
        ) : (
          <ActionForm action={action} className="space-y-3">
            <input type="hidden" name="expectedVersion" value={version} />
            {[...selected].map((id) => (
              <input key={id} type="hidden" name="orderItemIds" value={id} />
            ))}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2 border-b pb-2">
                <Checkbox
                  id="paid-cancel-all"
                  checked={allSelected}
                  onCheckedChange={(v) =>
                    setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())
                  }
                />
                <Label htmlFor="paid-cancel-all" className="font-medium">
                  {t('selectAll')}
                </Label>
              </div>
              {items.map((item) => (
                <div key={item.id} className="flex items-start gap-2">
                  <Checkbox
                    id={`paid-cancel-${item.id}`}
                    checked={selected.has(item.id)}
                    onCheckedChange={(v) => toggle(item.id, v === true)}
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor={`paid-cancel-${item.id}`}
                    className="flex-1 items-start justify-between gap-2 font-normal"
                  >
                    <span>
                      {item.label}
                      <span className="block text-xs text-muted-foreground">{item.detail}</span>
                    </span>
                    <span className="tabular-nums">{money(item.price)}</span>
                  </Label>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {t('selection', { count: selected.size })}
              </span>
              <span className="text-right">
                <span className="font-semibold tabular-nums">{money(sum)}</span>
                <span className="block text-xs text-muted-foreground">{t('feesNote')}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="paid-cancel-fees"
                name="refundFees"
                defaultChecked={refundFeesDefault}
              />
              <Label htmlFor="paid-cancel-fees" className="font-normal">
                {t('refundFees')}
              </Label>
            </div>
            <Textarea name="reason" rows={2} maxLength={500} placeholder={t('reason')} />
            <div className="flex items-center gap-2">
              <Checkbox id="paid-cancel-notify" name="notify" defaultChecked />
              <Label htmlFor="paid-cancel-notify" className="font-normal">
                {t('notify')}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="paid-cancel-confirm"
                name="confirmed"
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(v === true)}
              />
              <Label htmlFor="paid-cancel-confirm" className="font-normal">
                {t('confirm')}
              </Label>
            </div>
            <SubmitButton
              size="sm"
              variant="destructive"
              disabled={!confirmed || selected.size === 0}
            >
              {t('submit')}
            </SubmitButton>
          </ActionForm>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeSeatsCard({ orderId }: { orderId: string }) {
  const t = useTranslations('orders.admin.actions.changeSeats');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild size="sm" variant="outline">
          <Link href={`/admin/orders/${orderId}/change-seats`}>{t('open')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ResendCard({ orderId }: { orderId: string }) {
  const t = useTranslations('orders.admin.actions.resend');
  const [state, action] = useActionState(resendEmailAction.bind(null, orderId), IDLE);
  useFeedback(state);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ActionForm action={action}>
          <SubmitButton size="sm" variant="outline">
            {t('submit')}
          </SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

function ResendTicketsCard({ orderId }: { orderId: string }) {
  const t = useTranslations('orders.admin.actions.resendTickets');
  const [state, action] = useActionState(resendTicketsAction.bind(null, orderId), IDLE);
  useFeedback(state);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ActionForm action={action}>
          <SubmitButton size="sm" variant="outline">
            {t('submit')}
          </SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

function NoteCard({ orderId, note }: { orderId: string; note: string | null }) {
  const t = useTranslations('orders.admin.actions.note');
  const [state, action] = useActionState(internalNoteAction.bind(null, orderId), IDLE);
  useFeedback(state);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ActionForm action={action} className="space-y-3">
          <Textarea name="note" rows={4} maxLength={4000} defaultValue={note ?? ''} />
          <SubmitButton size="sm" variant="outline">
            {t('submit')}
          </SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}
