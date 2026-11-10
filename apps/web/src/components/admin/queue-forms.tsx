'use client';

import {
  ANNOUNCEMENT_SEVERITIES,
  QUEUE_ADMISSION_ORDERS,
  QUEUE_MODES,
  type QueueMode,
} from '@tix/shared';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { IDLE, type ActionState } from '@/lib/action-state';
import { cn } from '@/lib/utils';
import { ConfirmAction } from './confirm-action';
import {
  ActionForm,
  ActionFeedback,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export interface QueueConfigValues {
  mode: QueueMode;
  activeSessionThreshold: number;
  admissionBatchSize: number;
  admissionIntervalSeconds: number;
  passTokenTtlSeconds: number;
  lobbyOpensMinutesBefore: number;
  admissionOrder: (typeof QUEUE_ADMISSION_ORDERS)[number];
  accessCodeBypassesQueue: boolean;
  maxQueueSize: number | null;
  isPaused: boolean;
  title: string | null;
  message: string | null;
}

export function QueueConfigForm({
  action,
  initial,
  scope,
  usesGlobal = false,
}: {
  action: Action;
  initial: QueueConfigValues;
  scope: 'global' | 'event';
  usesGlobal?: boolean;
}) {
  const t = useTranslations('admin.queue');
  const tc = useTranslations('common.actions');
  const [state, formAction] = useActionState(action, IDLE);
  const [inherit, setInherit] = useState(usesGlobal);
  const [mode, setMode] = useState<QueueMode>(initial.mode);
  const err = (n: string) => errorOf(state, n);
  const num = (name: keyof QueueConfigValues, min: number, max: number, hint?: string) => (
    <Field label={t(`fields.${name}`)} htmlFor={`q-${name}`} error={err(name)} hint={hint}>
      <Input
        id={`q-${name}`}
        name={name}
        type="number"
        min={min}
        max={max}
        defaultValue={(initial[name] as number | null) ?? ''}
        required={name !== 'maxQueueSize'}
      />
    </Field>
  );

  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      {scope === 'event' && (
        <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
          <Switch
            name="useGlobal"
            checked={inherit}
            onCheckedChange={setInherit}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">{t('useGlobal')}</span>
            <span className="block text-muted-foreground">{t('useGlobalHint')}</span>
          </span>
        </label>
      )}
      <fieldset disabled={inherit} className={cn('space-y-5', inherit && 'opacity-50')}>
        <div className="space-y-2">
          <span className="text-sm font-medium">{t('fields.mode')}</span>
          <div className="grid gap-2 md:grid-cols-2">
            {QUEUE_MODES.map((m) => (
              <label
                key={m}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg border p-3 text-sm',
                  mode === m && 'border-primary ring-1 ring-primary',
                )}
              >
                <input
                  type="radio"
                  name="mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{t(`modes.${m}.label`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`modes.${m}.description`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {num('activeSessionThreshold', 1, 1_000_000, t('hints.activeSessionThreshold'))}
          {num('admissionBatchSize', 1, 100_000, t('hints.admissionBatchSize'))}
          {num('admissionIntervalSeconds', 1, 3600)}
          {num('passTokenTtlSeconds', 60, 86_400, t('hints.passTokenTtlSeconds'))}
          {num('lobbyOpensMinutesBefore', 0, 10_080, t('hints.lobbyOpensMinutesBefore'))}
          {num('maxQueueSize', 1, 10_000_000, t('hints.maxQueueSize'))}
          <Field label={t('fields.admissionOrder')} htmlFor="q-order" error={err('admissionOrder')}>
            <NativeSelect id="q-order" name="admissionOrder" defaultValue={initial.admissionOrder}>
              {QUEUE_ADMISSION_ORDERS.map((o) => (
                <option key={o} value={o}>
                  {t(`orders.${o}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-3 text-sm">
            <Switch
              name="accessCodeBypassesQueue"
              defaultChecked={initial.accessCodeBypassesQueue}
            />
            {t('fields.accessCodeBypassesQueue')}
          </label>
          <label className="flex items-center gap-3 text-sm">
            <Switch name="isPaused" defaultChecked={initial.isPaused} />
            {t('fields.isPaused')}
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('fields.title')} htmlFor="q-title" error={err('title')}>
            <Input id="q-title" name="title" defaultValue={initial.title ?? ''} maxLength={200} />
          </Field>
          <Field label={t('fields.message')} htmlFor="q-message" error={err('message')}>
            <Textarea
              id="q-message"
              name="message"
              rows={2}
              defaultValue={initial.message ?? ''}
              maxLength={4000}
            />
          </Field>
        </div>
      </fieldset>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

export function QueueStats({
  stats,
}: {
  stats: {
    waiting: number;
    lobby: number;
    admittedPending: number;
    active: number;
    cursor: number;
    seq: number;
  };
}) {
  const t = useTranslations('admin.queue.stats');
  const items: [string, number][] = [
    [t('waiting'), stats.waiting],
    [t('lobby'), stats.lobby],
    [t('admittedPending'), stats.admittedPending],
    [t('active'), stats.active],
    [t('cursor'), stats.cursor],
    [t('issued'), stats.seq],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-xl font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function QueueResetButton({ action }: { action: Action }) {
  const t = useTranslations('admin.queue.reset');
  return (
    <ConfirmAction
      action={action}
      title={t('title')}
      description={t('description')}
      confirmLabel={t('confirm')}
    >
      {t('button')}
    </ConfirmAction>
  );
}

export interface AnnouncementRow {
  id: string;
  message: string;
  severity: (typeof ANNOUNCEMENT_SEVERITIES)[number];
  publishedAt: string;
  expiresAt: string | null;
  translations: Record<string, Record<string, string> | undefined>;
  expire: Action;
  edit: Action;
}

function AnnouncementEditor({
  row,
  translationLocales,
}: {
  row: AnnouncementRow;
  translationLocales: string[];
}) {
  const t = useTranslations('admin.queue.announcements');
  const tr = useTranslations('translations.announcement');
  const uiLocale = useLocale();
  const [state, formAction] = useActionState(row.edit, IDLE);
  const names = new Intl.DisplayNames([uiLocale], { type: 'language' });
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">{tr('edit')}</summary>
      <ActionForm action={formAction} className="mt-2 space-y-3">
        <ActionFeedback state={state} />
        <Field label={t('message')} htmlFor={`e-${row.id}`} error={errorOf(state, 'message')}>
          <Textarea
            id={`e-${row.id}`}
            name="message"
            rows={2}
            maxLength={1000}
            defaultValue={row.message}
            required
          />
        </Field>
        {translationLocales.map((l) => (
          <Field
            key={l}
            label={tr('label', { language: names.of(l) ?? l })}
            htmlFor={`e-${row.id}-${l}`}
          >
            <Textarea
              id={`e-${row.id}-${l}`}
              name={`translation:${l}`}
              rows={2}
              maxLength={1000}
              defaultValue={row.translations[l]?.message ?? ''}
            />
          </Field>
        ))}
        <SubmitButton>{tr('save')}</SubmitButton>
      </ActionForm>
    </details>
  );
}

export function Announcements({
  create,
  items,
  translationLocales = [],
}: {
  create: Action;
  items: AnnouncementRow[];
  /** Languages besides the shop default the message can be translated into. */
  translationLocales?: string[];
}) {
  const t = useTranslations('admin.queue.announcements');
  const tr = useTranslations('translations.announcement');
  const uiLocale = useLocale();
  const format = useFormatter();
  const [state, formAction] = useActionState(create, IDLE);
  const now = Date.now();
  return (
    <div className="space-y-4">
      <ActionForm action={formAction} resetOnSuccess={state} className="space-y-3">
        <ActionFeedback state={state} />
        <Field label={t('message')} htmlFor="a-message" error={errorOf(state, 'message')}>
          <Textarea id="a-message" name="message" rows={2} maxLength={1000} required />
        </Field>
        {translationLocales.map((l) => (
          <Field
            key={l}
            label={tr('label', {
              language: new Intl.DisplayNames([uiLocale], { type: 'language' }).of(l) ?? l,
            })}
            htmlFor={`a-message-${l}`}
          >
            <Textarea id={`a-message-${l}`} name={`translation:${l}`} rows={2} maxLength={1000} />
          </Field>
        ))}
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label={t('severity')} htmlFor="a-severity">
            <NativeSelect id="a-severity" name="severity" defaultValue="INFO">
              {ANNOUNCEMENT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {t(`severities.${s}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            label={t('expiresInMinutes')}
            htmlFor="a-expires"
            error={errorOf(state, 'expiresInMinutes')}
          >
            <Input
              id="a-expires"
              name="expiresInMinutes"
              type="number"
              min={1}
              max={10080}
              placeholder={t('noExpiry')}
            />
          </Field>
          <SubmitButton>{t('publish')}</SubmitButton>
        </div>
      </ActionForm>
      {items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('message')}</TableHead>
              <TableHead>{t('severity')}</TableHead>
              <TableHead>{t('publishedAt')}</TableHead>
              <TableHead className="text-right">{t('state')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((a) => {
              const active = !a.expiresAt || new Date(a.expiresAt).getTime() > now;
              return (
                <TableRow key={a.id}>
                  <TableCell className="max-w-md whitespace-normal">
                    {a.message}
                    {active && (
                      <AnnouncementEditor row={a} translationLocales={translationLocales} />
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        a.severity === 'CRITICAL'
                          ? 'destructive'
                          : a.severity === 'WARNING'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {t(`severities.${a.severity}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {format.dateTime(new Date(a.publishedAt), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </TableCell>
                  <TableCell className="text-right">
                    {active ? (
                      <ConfirmAction
                        action={a.expire}
                        variant="secondary"
                        title={t('endTitle')}
                        confirmLabel={t('end')}
                      >
                        {t('end')}
                      </ConfirmAction>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('ended')}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
