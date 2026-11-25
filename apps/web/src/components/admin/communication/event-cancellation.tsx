'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { ActionForm, Field, SubmitButton } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { postponeEventAction, startEventCancellationAction } from '@/server/admin/communication';
import { COMMUNICATION_IDLE, useCommunicationFeedback } from './use-communication-feedback';

export interface CancellationPreviewData {
  unpaid: { orders: number; tickets: number };
  manual: { orders: number; tickets: number };
  paid: {
    orders: number;
    tickets: number;
    ticketsGross: number;
    feesGross: number;
    byMethod: { method: string; orders: number; gross: number }[];
    multiEventOrders: number;
  };
  runningRunId: string | null;
}

export interface CancellationRunItem {
  id: string;
  status: string;
  refundFees: boolean;
  totalOrders: number;
  cancelledOrders: number;
  manualOrders: number;
  failedOrders: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/**
 * Cancellation assistant: shows what a cancellation does (preview counts), then marks the event
 * cancelled and cancels / refunds every order in the background. For an already cancelled event it
 * shows the runs and lets the admin run the assistant again (picks up what is left).
 */
export function EventCancellationCard({
  eventId,
  status,
  currency,
  preview,
  runs,
}: {
  eventId: string;
  status: 'PUBLISHED' | 'POSTPONED' | 'CANCELLED';
  currency: string;
  preview: CancellationPreviewData;
  runs: CancellationRunItem[];
}) {
  const t = useTranslations('communication.cancellation');
  const tMethod = useTranslations('orders.method');
  const format = useFormatter();
  const cancelled = status === 'CANCELLED';
  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(
    startEventCancellationAction.bind(null, eventId),
    COMMUNICATION_IDLE,
  );
  useCommunicationFeedback(state);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  const [understood, setUnderstood] = useState(false);
  const running = preview.runningRunId !== null || runs.some((r) => r.status === 'RUNNING');
  const actionable = preview.unpaid.orders + preview.paid.orders;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{cancelled ? t('titleCancelled') : t('title')}</CardTitle>
        <CardDescription>
          {cancelled ? t('descriptionCancelled') : t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PreviewList preview={preview} money={money} tMethod={(m) => tMethod(m as never)} />
        {preview.manual.orders > 0 && (
          <Alert>
            <AlertDescription>
              {t('manualNotice', { count: preview.manual.orders })}
            </AlertDescription>
          </Alert>
        )}
        {running && (
          <Alert>
            <AlertDescription>{t('running')}</AlertDescription>
          </Alert>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant={cancelled ? 'outline' : 'destructive'}
              disabled={running || (cancelled && actionable === 0)}
              data-testid="event-cancel-open"
            >
              {cancelled ? t('rerun') : t('open')}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{cancelled ? t('rerunTitle') : t('wizardTitle')}</DialogTitle>
              <DialogDescription>{t('wizardDescription')}</DialogDescription>
            </DialogHeader>
            <ActionForm action={action} className="space-y-4">
              <PreviewList preview={preview} money={money} tMethod={(m) => tMethod(m as never)} />
              {!cancelled && (
                <Field label={t('reason')} htmlFor="cancel-reason" hint={t('reasonHint')}>
                  <Textarea id="cancel-reason" name="reason" rows={2} maxLength={1000} />
                </Field>
              )}
              <div className="flex items-start gap-2">
                <Checkbox id="cancel-fees" name="refundFees" defaultChecked className="mt-0.5" />
                <Label htmlFor="cancel-fees" className="font-normal">
                  {t('refundFees')}
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox id="cancel-notify" name="notify" defaultChecked className="mt-0.5" />
                <Label htmlFor="cancel-notify" className="font-normal">
                  {t('notify')}
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="cancel-understood"
                  checked={understood}
                  onCheckedChange={(v) => setUnderstood(v === true)}
                  className="mt-0.5"
                  data-testid="event-cancel-understood"
                />
                <Label htmlFor="cancel-understood" className="font-normal">
                  {t('understood')}
                </Label>
              </div>
              {understood && <input type="hidden" name="confirm" value="CANCEL" />}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  {t('back')}
                </Button>
                <SubmitButton
                  variant="destructive"
                  disabled={!understood}
                  pendingLabel={t('starting')}
                  data-testid="event-cancel-start"
                >
                  {cancelled ? t('startRerun') : t('start')}
                </SubmitButton>
              </DialogFooter>
            </ActionForm>
          </DialogContent>
        </Dialog>
        {runs.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium">{t('runs')}</h3>
            <ul className="divide-y text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <div>
                      {format.dateTime(new Date(r.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('runCounts', {
                        cancelled: r.cancelledOrders,
                        manual: r.manualOrders,
                        failed: r.failedOrders,
                      })}
                    </div>
                    {r.lastError && (
                      <div className="break-words text-xs text-destructive">{r.lastError}</div>
                    )}
                  </div>
                  <Badge
                    variant={
                      r.status === 'COMPLETED'
                        ? 'secondary'
                        : r.status === 'RUNNING'
                          ? 'outline'
                          : 'destructive'
                    }
                  >
                    {t(`runStatus.${r.status}` as never)}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PreviewList({
  preview,
  money,
  tMethod,
}: {
  preview: CancellationPreviewData;
  money: (cents: number) => string;
  tMethod: (method: string) => string;
}) {
  const t = useTranslations('communication.cancellation.preview');
  return (
    <ul className="space-y-1 text-sm" data-testid="event-cancel-preview">
      <li>{t('unpaid', { orders: preview.unpaid.orders, tickets: preview.unpaid.tickets })}</li>
      <li>
        {t('paid', {
          orders: preview.paid.orders,
          tickets: preview.paid.tickets,
          amount: money(preview.paid.ticketsGross),
        })}
      </li>
      {preview.paid.feesGross > 0 && (
        <li className="text-muted-foreground">
          {t('fees', { amount: money(preview.paid.feesGross) })}
        </li>
      )}
      {preview.paid.byMethod.map((m) => (
        <li key={m.method} className="pl-4 text-muted-foreground">
          {t('method', {
            method: tMethod(m.method),
            orders: m.orders,
            amount: money(m.gross),
            how: t(m.method === 'PAYPAL' ? 'howAutomatic' : 'howManual'),
          })}
        </li>
      ))}
      {preview.paid.multiEventOrders > 0 && (
        <li className="text-muted-foreground">
          {t('multi', { orders: preview.paid.multiEventOrders })}
        </li>
      )}
      {preview.manual.orders > 0 && (
        <li className="text-warning">{t('manual', { orders: preview.manual.orders })}</li>
      )}
    </ul>
  );
}

/** Postponement: the event stays on sale, tickets stay valid; optionally mails every buyer. */
export function EventPostponeCard({
  eventId,
  status,
  timeZone,
  newStartsAt,
  note,
}: {
  eventId: string;
  status: 'PUBLISHED' | 'POSTPONED';
  timeZone: string;
  /** Announced new date as wall time in the event time zone (`YYYY-MM-DDTHH:mm`) or ''. */
  newStartsAt: string;
  note: string;
}) {
  const t = useTranslations('communication.postpone');
  const [state, action] = useActionState(
    postponeEventAction.bind(null, eventId),
    COMMUNICATION_IDLE,
  );
  useCommunicationFeedback(state);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{status === 'POSTPONED' ? t('titlePostponed') : t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ActionForm action={action} className="space-y-3">
          <Field label={t('newDate', { timeZone })} htmlFor="postpone-date" hint={t('newDateHint')}>
            <Input
              id="postpone-date"
              name="newStartsAt"
              type="datetime-local"
              defaultValue={newStartsAt}
            />
          </Field>
          <Field label={t('note')} htmlFor="postpone-note">
            <Textarea
              id="postpone-note"
              name="note"
              rows={3}
              maxLength={2000}
              defaultValue={note}
            />
          </Field>
          <div className="flex items-start gap-2">
            <Checkbox id="postpone-notify" name="notify" defaultChecked className="mt-0.5" />
            <Label htmlFor="postpone-notify" className="font-normal">
              {t('notify')}
            </Label>
          </div>
          <SubmitButton variant="outline" pendingLabel={t('saving')}>
            {status === 'POSTPONED' ? t('update') : t('postpone')}
          </SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}
