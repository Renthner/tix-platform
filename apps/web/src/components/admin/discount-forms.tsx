'use client';

import { DISCOUNT_BULK_MAX, formatHundredths, type DiscountCodeType } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  ActionFeedback,
  ActionForm,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export interface DiscountScopeOptions {
  events: { id: string; title: string }[];
  categories: { id: string; name: string; eventId: string }[];
  tariffs: { id: string; name: string; eventId: string }[];
}

export interface DiscountFormValues {
  code: string;
  type: DiscountCodeType;
  value: number;
  allEvents: boolean;
  eventIds: string[];
  categoryIds: string[];
  ticketTypeIds: string[];
  /** `YYYY-MM-DDTHH:MM` in the shop time zone. */
  validFrom: string;
  validUntil: string;
  maxTotalUses: number | null;
  maxUsesPerEmail: number | null;
  minOrderValue: number | null;
  discountFees: boolean;
  stackable: boolean;
  isActive: boolean;
  note: string;
}

function CheckList({
  name,
  items,
  selected,
  eventTitle,
}: {
  name: string;
  items: { id: string; label: string; eventId: string }[];
  selected: string[];
  eventTitle: (eventId: string) => string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
      {items.map((i) => (
        <label key={i.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            name={name}
            value={i.id}
            defaultChecked={selected.includes(i.id)}
          />
          <span>
            {i.label}{' '}
            <span className="text-xs text-muted-foreground">· {eventTitle(i.eventId)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Create (single / bulk) or edit a discount code. */
export function DiscountForm({
  action,
  options,
  timeZone,
  currency,
  initial,
}: {
  action: Action;
  options: DiscountScopeOptions;
  timeZone: string;
  currency: string;
  /** Present when editing (the code itself cannot change). */
  initial?: DiscountFormValues;
}) {
  const t = useTranslations('discounts');
  const [state, formAction] = useActionState(action, IDLE);
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [type, setType] = useState<DiscountCodeType>(initial?.type ?? 'PERCENT');
  const [selectedScope, setSelectedScope] = useState(initial ? !initial.allEvents : false);
  const err = (n: string) => errorOf(state, n);
  const editing = Boolean(initial);
  const titleOf = (id: string) => options.events.find((e) => e.id === id)?.title ?? '';
  const inScope = (_eventId: string) => true;
  const initialValue = initial
    ? formatHundredths(initial.value, initial.type === 'PERCENT' ? 'percent' : 'money')
    : '';
  return (
    <ActionForm
      action={formAction}
      resetOnSuccess={editing ? undefined : state}
      unsavedGuard={editing ? state : undefined}
      className="space-y-5"
    >
      <ActionFeedback state={state} />
      {!editing && (
        <div className="flex gap-4 text-sm">
          {(['single', 'bulk'] as const).map((m) => (
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
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {editing ? (
          <Field label={t('fields.code')}>
            <div className="h-9 rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
              {initial!.code}
            </div>
          </Field>
        ) : mode === 'single' ? (
          <Field
            label={t('fields.code')}
            htmlFor="dc-code"
            error={err('code')}
            hint={t('hints.code')}
          >
            <Input id="dc-code" name="code" className="uppercase" maxLength={40} required />
          </Field>
        ) : (
          <>
            <Field
              label={t('fields.count')}
              htmlFor="dc-count"
              error={err('count')}
              hint={t('hints.count', { max: DISCOUNT_BULK_MAX })}
            >
              <Input
                id="dc-count"
                name="count"
                type="number"
                min={1}
                max={DISCOUNT_BULK_MAX}
                defaultValue={50}
                required
              />
            </Field>
            <Field
              label={t('fields.prefix')}
              htmlFor="dc-prefix"
              error={err('prefix')}
              hint={t('hints.prefix')}
            >
              <Input id="dc-prefix" name="prefix" className="uppercase" maxLength={12} />
            </Field>
          </>
        )}
        <Field label={t('fields.type')} htmlFor="dc-type">
          <NativeSelect
            id="dc-type"
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value as DiscountCodeType)}
          >
            <option value="PERCENT">{t('types.PERCENT')}</option>
            <option value="FIXED">{t('types.FIXED')}</option>
          </NativeSelect>
        </Field>
        <Field
          label={
            type === 'PERCENT' ? t('fields.valuePercent') : t('fields.valueFixed', { currency })
          }
          htmlFor="dc-value"
          error={err('value')}
          hint={type === 'FIXED' ? t('hints.fixed') : undefined}
        >
          <Input
            id="dc-value"
            name="value"
            inputMode="decimal"
            defaultValue={initialValue}
            required
          />
        </Field>
        <Field
          label={t('fields.validFrom')}
          htmlFor="dc-from"
          error={err('validFrom')}
          hint={t('hints.zone', { timeZone })}
        >
          <Input
            id="dc-from"
            name="validFrom"
            type="datetime-local"
            defaultValue={initial?.validFrom}
          />
        </Field>
        <Field label={t('fields.validUntil')} htmlFor="dc-until" error={err('validUntil')}>
          <Input
            id="dc-until"
            name="validUntil"
            type="datetime-local"
            defaultValue={initial?.validUntil}
          />
        </Field>
        {!(mode === 'bulk' && !editing) && (
          <Field
            label={t('fields.maxTotalUses')}
            htmlFor="dc-max"
            error={err('maxTotalUses')}
            hint={t('hints.unlimited')}
          >
            <Input
              id="dc-max"
              name="maxTotalUses"
              type="number"
              min={1}
              defaultValue={initial?.maxTotalUses ?? ''}
            />
          </Field>
        )}
        <Field
          label={t('fields.maxUsesPerEmail')}
          htmlFor="dc-email"
          error={err('maxUsesPerEmail')}
          hint={t('hints.unlimited')}
        >
          <Input
            id="dc-email"
            name="maxUsesPerEmail"
            type="number"
            min={1}
            defaultValue={initial?.maxUsesPerEmail ?? ''}
          />
        </Field>
        <Field
          label={t('fields.minOrderValue', { currency })}
          htmlFor="dc-min"
          error={err('minOrderValue')}
          hint={t('hints.minOrderValue')}
        >
          <Input
            id="dc-min"
            name="minOrderValue"
            inputMode="decimal"
            defaultValue={
              initial?.minOrderValue != null ? formatHundredths(initial.minOrderValue, 'money') : ''
            }
          />
        </Field>
      </div>
      {mode === 'bulk' && !editing && (
        <p className="text-xs text-muted-foreground">{t('hints.bulkSingleUse')}</p>
      )}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t('scope.title')}</legend>
        <div className="flex gap-4 text-sm">
          {(['all', 'selected'] as const).map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value={s}
                checked={(s === 'selected') === selectedScope}
                onChange={() => setSelectedScope(s === 'selected')}
              />
              {t(`scope.${s}`)}
            </label>
          ))}
        </div>
        {selectedScope && (
          <Field label={t('scope.events')} error={err('eventIds')}>
            <CheckList
              name="eventIds"
              items={options.events.map((e) => ({ id: e.id, label: e.title, eventId: e.id }))}
              selected={initial?.eventIds ?? []}
              eventTitle={() => ''}
            />
          </Field>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('scope.categories')} hint={t('scope.restrictHint')}>
            <CheckList
              name="categoryIds"
              items={options.categories
                .filter((c) => inScope(c.eventId))
                .map((c) => ({ id: c.id, label: c.name, eventId: c.eventId }))}
              selected={initial?.categoryIds ?? []}
              eventTitle={titleOf}
            />
          </Field>
          <Field label={t('scope.tariffs')} hint={t('scope.restrictHint')}>
            <CheckList
              name="ticketTypeIds"
              items={options.tariffs
                .filter((c) => inScope(c.eventId))
                .map((c) => ({ id: c.id, label: c.name, eventId: c.eventId }))}
              selected={initial?.ticketTypeIds ?? []}
              eventTitle={titleOf}
            />
          </Field>
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-3 text-sm">
          <Switch name="discountFees" defaultChecked={initial?.discountFees ?? false} />
          {t('fields.discountFees')}
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch name="stackable" defaultChecked={initial?.stackable ?? false} />
          {t('fields.stackable')}
        </label>
        {editing && (
          <label className="flex items-center gap-3 text-sm">
            <Switch name="isActive" defaultChecked={initial!.isActive} />
            {t('fields.isActive')}
          </label>
        )}
      </div>
      <Field label={t('fields.note')} htmlFor="dc-note" error={err('note')} hint={t('hints.note')}>
        <Textarea
          id="dc-note"
          name="note"
          rows={2}
          maxLength={500}
          defaultValue={initial?.note ?? ''}
        />
      </Field>
      <SubmitButton>
        {editing ? t('save') : mode === 'single' ? t('createSingle') : t('createBulk')}
      </SubmitButton>
    </ActionForm>
  );
}
