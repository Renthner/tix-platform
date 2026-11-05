'use client';

import { ACCESS_CODE_TYPES, type AccessCodeType } from '@tix/shared';
import { useFormatter, useTranslations } from 'next-intl';
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
import { IDLE, type ActionState } from '@/lib/action-state';
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

export interface AccessCodeRow {
  id: string;
  code: string;
  label: string | null;
  type: AccessCodeType;
  redemptionCount: number;
  maxRedemptions: number | null;
  maxTicketsPerOrder: number | null;
  maxTicketsTotal: number | null;
  bypassesQueue: boolean;
  grantsPresaleAccess: boolean;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  toggle: Action;
}

export function AccessCodeCreateForm({ action, timeZone }: { action: Action; timeZone: string }) {
  const t = useTranslations('admin.accessCodes');
  const [state, formAction] = useActionState(action, IDLE);
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [type, setType] = useState<AccessCodeType>('MULTI_USE');
  const err = (n: string) => errorOf(state, n);
  return (
    <ActionForm action={formAction} resetOnSuccess={state} className="space-y-4">
      <ActionFeedback state={state} />
      <div className="flex gap-4 text-sm">
        {(['single', 'batch'] as const).map((m) => (
          <label key={m} className="flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            {t(`modes.${m}`)}
          </label>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {mode === 'single' ? (
          <Field label={t('code')} htmlFor="ac-code" error={err('code')} hint={t('codeHint')}>
            <Input id="ac-code" name="code" className="uppercase" maxLength={64} required />
          </Field>
        ) : (
          <>
            <Field label={t('count')} htmlFor="ac-count" error={err('count')}>
              <Input
                id="ac-count"
                name="count"
                type="number"
                min={1}
                max={500}
                defaultValue={10}
                required
              />
            </Field>
            <Field
              label={t('prefix')}
              htmlFor="ac-prefix"
              error={err('prefix')}
              hint={t('prefixHint')}
            >
              <Input id="ac-prefix" name="prefix" maxLength={20} className="uppercase" />
            </Field>
          </>
        )}
        <Field label={t('label')} htmlFor="ac-label" error={err('label')}>
          <Input id="ac-label" name="label" maxLength={200} />
        </Field>
        <Field label={t('type')} htmlFor="ac-type" error={err('type')}>
          <NativeSelect
            id="ac-type"
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value as AccessCodeType)}
          >
            {ACCESS_CODE_TYPES.map((tp) => (
              <option key={tp} value={tp}>
                {t(`types.${tp}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {type === 'MULTI_USE' && (
          <Field
            label={t('maxRedemptions')}
            htmlFor="ac-max"
            error={err('maxRedemptions')}
            hint={t('unlimitedHint')}
          >
            <Input id="ac-max" name="maxRedemptions" type="number" min={1} />
          </Field>
        )}
        <Field label={t('maxTicketsPerOrder')} htmlFor="ac-mpo" error={err('maxTicketsPerOrder')}>
          <Input id="ac-mpo" name="maxTicketsPerOrder" type="number" min={1} />
        </Field>
        <Field label={t('maxTicketsTotal')} htmlFor="ac-mtt" error={err('maxTicketsTotal')}>
          <Input id="ac-mtt" name="maxTicketsTotal" type="number" min={1} />
        </Field>
        <Field
          label={t('validFrom')}
          htmlFor="ac-from"
          error={err('validFrom')}
          hint={t('zoneHint', { timeZone })}
        >
          <Input id="ac-from" name="validFrom" type="datetime-local" />
        </Field>
        <Field label={t('validUntil')} htmlFor="ac-until" error={err('validUntil')}>
          <Input id="ac-until" name="validUntil" type="datetime-local" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-3 text-sm">
          <Switch name="bypassesQueue" defaultChecked />
          {t('bypassesQueue')}
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch name="grantsPresaleAccess" defaultChecked />
          {t('grantsPresaleAccess')}
        </label>
      </div>
      <SubmitButton>{mode === 'single' ? t('createSingle') : t('createBatch')}</SubmitButton>
    </ActionForm>
  );
}

export function AccessCodeTable({ codes, timeZone }: { codes: AccessCodeRow[]; timeZone: string }) {
  const t = useTranslations('admin.accessCodes');
  const format = useFormatter();
  const date = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short', timeZone })
      : '–';
  if (codes.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('code')}</TableHead>
            <TableHead>{t('type')}</TableHead>
            <TableHead className="text-right">{t('redemptions')}</TableHead>
            <TableHead>{t('limits')}</TableHead>
            <TableHead>{t('validity')}</TableHead>
            <TableHead>{t('permissions')}</TableHead>
            <TableHead className="text-right">{t('status')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {codes.map((c) => (
            <TableRow key={c.id} className={c.isActive ? undefined : 'opacity-60'}>
              <TableCell>
                <span className="font-mono font-medium">{c.code}</span>
                {c.label && <span className="block text-xs text-muted-foreground">{c.label}</span>}
              </TableCell>
              <TableCell>{t(`types.${c.type}`)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {c.redemptionCount} / {c.maxRedemptions ?? '∞'}
              </TableCell>
              <TableCell className="text-xs">
                {t('limitsValue', {
                  perOrder: c.maxTicketsPerOrder ?? '–',
                  total: c.maxTicketsTotal ?? '–',
                })}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs">
                {date(c.validFrom)} – {date(c.validUntil)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {c.bypassesQueue && <Badge variant="secondary">{t('bypassesQueueShort')}</Badge>}
                  {c.grantsPresaleAccess && <Badge variant="secondary">{t('presaleShort')}</Badge>}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <ConfirmAction
                  action={c.toggle}
                  variant={c.isActive ? 'destructive' : 'secondary'}
                  title={c.isActive ? t('deactivateTitle') : t('activateTitle')}
                  description={c.code}
                  confirmLabel={c.isActive ? t('deactivate') : t('activate')}
                >
                  {c.isActive ? t('deactivate') : t('activate')}
                </ConfirmAction>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
