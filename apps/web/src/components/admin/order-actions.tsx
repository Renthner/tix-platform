'use client';

import type { OrderStatus } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { centsToInput } from '@/lib/money';
import {
  cancelOrderAction,
  internalNoteAction,
  keepReservedAction,
  recordPaymentAction,
  resendEmailAction,
  type OrderActionState,
} from '@/server/admin/orders';

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
}) {
  const open = props.status === 'PENDING' || props.status === 'AWAITING_PAYMENT';
  return (
    <>
      {open && props.status === 'AWAITING_PAYMENT' && <KeepReservedCard {...props} />}
      {props.canRecordPayment && (open || props.status === 'PAID') && <PaymentCard {...props} />}
      {open && <CancelCard orderId={props.orderId} />}
      {props.canResend && <ResendCard orderId={props.orderId} />}
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
}: {
  orderId: string;
  outstanding: number;
  currency: string;
}) {
  const t = useTranslations('orders.admin.actions.payment');
  const tMethod = useTranslations('orders.method');
  const [state, action] = useActionState(recordPaymentAction.bind(null, orderId), IDLE);
  useFeedback(state);
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

function CancelCard({ orderId }: { orderId: string }) {
  const t = useTranslations('orders.admin.actions.cancel');
  const [state, action] = useActionState(cancelOrderAction.bind(null, orderId), IDLE);
  useFeedback(state);
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
