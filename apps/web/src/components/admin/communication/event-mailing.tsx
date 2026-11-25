'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { Field, NativeSelect } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  countEventMailingRecipientsAction,
  sendEventMailingAction,
  testEventMailingAction,
} from '@/server/admin/communication';
import { COMMUNICATION_IDLE, useCommunicationFeedback } from './use-communication-feedback';

export interface MailingHistoryItem {
  id: string;
  kind: string;
  audience: string;
  subject: string;
  status: string;
  recipientCount: number;
  sentCount: number;
  createdAt: string;
}

type Audience = 'PAID' | 'ACTIVE' | 'CATEGORY';

/** Bulk e-mail to the buyers of an event: recipient filter, preview, test mail, confirmation. */
export function EventMailingCard({
  eventId,
  categories,
  history,
}: {
  eventId: string;
  categories: { id: string; name: string }[];
  history: MailingHistoryItem[];
}) {
  const t = useTranslations('communication.mailing');
  const format = useFormatter();
  const [audience, setAudience] = useState<Audience>('PAID');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [, startCount] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const [sendState, sendAction] = useActionState(
    sendEventMailingAction.bind(null, eventId),
    COMMUNICATION_IDLE,
  );
  const [testState, testAction] = useActionState(
    testEventMailingAction.bind(null, eventId),
    COMMUNICATION_IDLE,
  );
  useCommunicationFeedback(sendState);
  useCommunicationFeedback(testState);
  const [, startSend] = useTransition();

  useEffect(() => {
    let current = true;
    startCount(async () => {
      const n = await countEventMailingRecipientsAction(
        eventId,
        audience,
        audience === 'CATEGORY' ? categoryId || null : null,
      );
      if (current) setCount(n);
    });
    return () => {
      current = false;
    };
  }, [eventId, audience, categoryId, sendState]);

  useEffect(() => {
    if (sendState.status === 'success') {
      setSubject('');
      setBody('');
    }
  }, [sendState]);

  const ready = subject.trim() !== '' && body.trim() !== '' && (count ?? 0) > 0;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            ref={formRef}
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (formRef.current?.reportValidity() && ready) setConfirmOpen(true);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('audience')} htmlFor="mailing-audience">
                <NativeSelect
                  id="mailing-audience"
                  name="audience"
                  value={audience}
                  onChange={(e) => setAudience(e.target.value as Audience)}
                >
                  <option value="PAID">{t('audiences.PAID')}</option>
                  <option value="ACTIVE">{t('audiences.ACTIVE')}</option>
                  <option value="CATEGORY" disabled={categories.length === 0}>
                    {t('audiences.CATEGORY')}
                  </option>
                </NativeSelect>
              </Field>
              {audience === 'CATEGORY' && (
                <Field label={t('category')} htmlFor="mailing-category">
                  <NativeSelect
                    id="mailing-category"
                    name="categoryId"
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
            </div>
            <p className="text-sm" data-testid="mailing-recipient-count">
              {count === null ? t('counting') : t('recipients', { count })}
            </p>
            <Field label={t('subject')} htmlFor="mailing-subject">
              <Input
                id="mailing-subject"
                name="subject"
                required
                maxLength={200}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </Field>
            <Field label={t('body')} htmlFor="mailing-body" hint={t('bodyHint')}>
              <Textarea
                id="mailing-body"
                name="body"
                required
                rows={8}
                maxLength={10000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!ready} data-testid="mailing-send">
                {t('send')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={subject.trim() === '' || body.trim() === ''}
                onClick={() => {
                  const form = formRef.current;
                  if (!form) return;
                  startSend(() => testAction(new FormData(form)));
                }}
              >
                {t('test')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('previewTitle')}</CardTitle>
          <CardDescription>{t('previewHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-muted/30 p-4 text-sm">
            <div className="mb-3 font-medium">{subject || t('previewSubject')}</div>
            <div className="whitespace-pre-wrap">{body || t('previewBody')}</div>
          </div>
        </CardContent>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('history')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {history.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {m.kind === 'EVENT_POSTPONED' ? t('postponedMailing') : m.subject}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {format.dateTime(new Date(m.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}{' '}
                      · {t(`audiences.${m.audience}` as never)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {m.sentCount} / {m.recipientCount}
                    </span>
                    <Badge variant={m.status === 'COMPLETED' ? 'secondary' : 'outline'}>
                      {t(`status.${m.status}` as never)}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('confirmTitle')}
        description={t('confirmText', { count: count ?? 0 })}
        confirmLabel={t('confirm', { count: count ?? 0 })}
        variant="default"
        onConfirm={() => {
          const form = formRef.current;
          if (!form) return;
          const data = new FormData(form);
          startSend(() => sendAction(data));
        }}
      />
    </div>
  );
}
