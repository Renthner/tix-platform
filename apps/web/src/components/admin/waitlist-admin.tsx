'use client';

import { Download } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ActionFeedback, ActionForm, SubmitButton } from './form-controls';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export interface WaitlistRowView {
  id: string;
  email: string;
  firstName: string | null;
  quantity: number;
  categoryName: string | null;
  confirmed: boolean;
  createdAt: string;
  lastNotifiedAt: string | null;
  notifiedCount: number;
  remove: Action;
}

function RemoveForm({ action }: { action: Action }) {
  const t = useTranslations('admin.waitlistAdmin');
  const [, formAction] = useActionState(action, IDLE);
  return (
    <ActionForm action={formAction} className="flex items-center justify-end gap-3">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" name="notify" />
        {t('removeNotify')}
      </label>
      <SubmitButton variant="outline" size="sm">
        {t('remove')}
      </SubmitButton>
    </ActionForm>
  );
}

/** Waiting list of an event (event tab "Sales"): entries, CSV export, "notify now", removal. */
export function WaitlistAdmin({
  eventId,
  notify,
  rows,
}: {
  eventId: string;
  notify: (state: ActionState) => Promise<ActionState>;
  rows: WaitlistRowView[];
}) {
  const t = useTranslations('admin.waitlistAdmin');
  const format = useFormatter();
  const [state, formAction] = useActionState(notify, IDLE);
  const confirmed = rows.filter((r) => r.confirmed).length;
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' });
  return (
    <Card data-slot="waitlist-admin">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm" data-slot="waitlist-count">
            {t('count', { confirmed, pending: rows.length - confirmed })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={`/api/admin/events/${eventId}/waitlist`}>
                <Download className="size-4" />
                {t('export')}
              </a>
            </Button>
            <ActionForm action={formAction}>
              <SubmitButton size="sm" disabled={confirmed === 0}>
                {t('notifyNow')}
              </SubmitButton>
            </ActionForm>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('notifyHint')}</p>
        <ActionFeedback state={state} />
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colEmail')}</TableHead>
                <TableHead>{t('colName')}</TableHead>
                <TableHead>{t('colTickets')}</TableHead>
                <TableHead>{t('colCategory')}</TableHead>
                <TableHead>{t('colStatus')}</TableHead>
                <TableHead>{t('colSignedUp')}</TableHead>
                <TableHead>{t('colNotified')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} data-slot="waitlist-row">
                  <TableCell className="font-mono text-xs">{r.email}</TableCell>
                  <TableCell>{r.firstName ?? ''}</TableCell>
                  <TableCell>{r.quantity}</TableCell>
                  <TableCell>{r.categoryName ?? t('anyCategory')}</TableCell>
                  <TableCell>
                    <Badge variant={r.confirmed ? 'default' : 'secondary'}>
                      {r.confirmed ? t('confirmed') : t('pending')}
                    </Badge>
                  </TableCell>
                  <TableCell>{date(r.createdAt)}</TableCell>
                  <TableCell>
                    {r.lastNotifiedAt
                      ? `${date(r.lastNotifiedAt)} (${t('times', { count: r.notifiedCount })})`
                      : t('never')}
                  </TableCell>
                  <TableCell>
                    <RemoveForm action={r.remove} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
