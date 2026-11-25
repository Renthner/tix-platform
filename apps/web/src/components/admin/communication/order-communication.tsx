'use client';

import type { EmailStatus } from '@tix/shared';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useRef, useState, useTransition } from 'react';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  changeOrderEmailAction,
  retryOrderEmailAction,
  sendOrderMessageAction,
} from '@/server/admin/communication';
import { COMMUNICATION_IDLE, useCommunicationFeedback } from './use-communication-feedback';

/** Free-text message to the buyer of an order (sent with the shop branding, logged in the history). */
export function OrderMessageCard({ orderId, hasEmail }: { orderId: string; hasEmail: boolean }) {
  const t = useTranslations('communication.orderMessage');
  const [state, action] = useActionState(
    sendOrderMessageAction.bind(null, orderId),
    COMMUNICATION_IDLE,
  );
  useCommunicationFeedback(state);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{hasEmail ? t('description') : t('noEmail')}</CardDescription>
      </CardHeader>
      {hasEmail && (
        <CardContent>
          <ActionForm
            key={state.status === 'success' ? state.at : 'form'}
            action={action}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="om-subject">{t('subject')}</Label>
              <Input id="om-subject" name="subject" required maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="om-body">{t('body')}</Label>
              <Textarea id="om-body" name="body" required rows={6} maxLength={10000} />
            </div>
            <SubmitButton size="sm" pendingLabel={t('sending')}>
              {t('send')}
            </SubmitButton>
          </ActionForm>
        </CardContent>
      )}
    </Card>
  );
}

/**
 * Changes ONLY the buyer e-mail of the order (name and address stay as invoiced). A confirmation
 * dialog explains the consequences: new order link, notice to the old address.
 */
export function OrderEmailChangeCard({
  orderId,
  version,
  currentEmail,
}: {
  orderId: string;
  version: number;
  currentEmail: string | null;
}) {
  const t = useTranslations('communication.emailChange');
  const [state, action] = useActionState(
    changeOrderEmailAction.bind(null, orderId),
    COMMUNICATION_IDLE,
  );
  useCommunicationFeedback(state);
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [override, setOverride] = useState(false);
  const limitError = state.status === 'error' && state.code === 'CUSTOMER_LIMIT';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (formRef.current?.reportValidity()) setConfirmOpen(true);
          }}
        >
          <input type="hidden" name="expectedVersion" value={version} />
          <p className="text-sm text-muted-foreground">
            {t('current')}:{' '}
            <span className="font-medium text-foreground">{currentEmail ?? '–'}</span>
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="oe-email">{t('newEmail')}</Label>
            <Input
              id="oe-email"
              name="email"
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {limitError && (
            <div className="flex items-start gap-2">
              <Checkbox
                id="oe-override"
                name="overrideLimits"
                checked={override}
                onCheckedChange={(v) => setOverride(v === true)}
                className="mt-0.5"
              />
              <Label htmlFor="oe-override" className="text-sm font-normal">
                {t('overrideLimits')}
              </Label>
            </div>
          )}
          <Button type="submit" size="sm" variant="outline">
            {t('change')}
          </Button>
        </form>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('confirmTitle')}
        description={t('confirmText', { email })}
        confirmLabel={t('confirm')}
        variant="default"
        onConfirm={() => {
          const form = formRef.current;
          if (!form) return;
          const data = new FormData(form);
          if (override) data.set('overrideLimits', 'on');
          startTransition(() => action(data));
        }}
      />
    </Card>
  );
}

export interface OrderEmailItem {
  id: string;
  templateKey: string | null;
  toEmail: string;
  subject: string;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  retryable: boolean;
}

function RetryButton({ messageId }: { messageId: string }) {
  const t = useTranslations('communication.orderEmails');
  const [state, action] = useActionState(
    retryOrderEmailAction.bind(null, messageId),
    COMMUNICATION_IDLE,
  );
  useCommunicationFeedback(state);
  return (
    <ActionForm action={action}>
      <SubmitButton size="sm" variant="outline" pendingLabel={t('retrying')}>
        {t('retry')}
      </SubmitButton>
    </ActionForm>
  );
}

/** E-mails sent for the order (type, time, status, error text) with "send again" for failed ones. */
export function OrderEmailsCard({
  items,
  templateLabels,
  canRetry,
}: {
  items: OrderEmailItem[];
  /** Display name per template key (from the e-mail template catalogue). */
  templateLabels: Record<string, string>;
  canRetry: boolean;
}) {
  const t = useTranslations('communication.orderEmails');
  const format = useFormatter();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y text-sm" data-testid="order-emails">
            {items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-medium">
                    {(m.templateKey && templateLabels[m.templateKey]) || m.templateKey || '–'}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {when(m.sentAt ?? m.createdAt)} · {m.toEmail}
                  </div>
                  {m.status === 'SENT' && m.subject && !m.subject.startsWith('[') && (
                    <div className="truncate text-xs text-muted-foreground">{m.subject}</div>
                  )}
                  {m.status === 'SKIPPED' ? (
                    <div className="break-words text-xs text-muted-foreground">
                      {t('skippedReservedDomain')}
                    </div>
                  ) : (
                    m.lastError &&
                    m.status !== 'SENT' && (
                      <div className="break-words text-xs text-destructive">{m.lastError}</div>
                    )
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      m.status === 'FAILED'
                        ? 'destructive'
                        : m.status === 'SENT'
                          ? 'secondary'
                          : 'outline'
                    }
                  >
                    {t(`status.${m.status}`)}
                  </Badge>
                  {canRetry && m.retryable && <RetryButton messageId={m.id} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
