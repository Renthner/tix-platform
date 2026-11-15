'use client';

import {
  FEE_CALCULATIONS,
  FEE_SCOPES,
  FEE_PAYMENT_METHODS,
  SALES_CHANNELS,
  formatHundredths,
  type FeeCalculation,
  type FeeScope,
} from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
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
import { Switch } from '@/components/ui/switch';
import type { FeeActionState } from '@/server/admin/fees';
import { ActionForm, Field, NativeSelect, SubmitButton, errorOf } from '../form-controls';
import type { Action, FeeView, TaxRateOption } from './types';
import { FeeFeedback, useDialogAction } from './ui';

// ─── Fee form ───────────────────────────────────────────────────────────────

type FeeFormMode = 'global' | 'override' | 'event';

function FeeFields({
  mode,
  initial,
  taxRates,
  currency,
  state,
  scopeLocked = false,
}: {
  mode: FeeFormMode;
  initial?: Partial<FeeView>;
  taxRates: TaxRateOption[];
  currency: string;
  state: FeeActionState;
  /** Events adjust this global fee → it cannot become PER_ORDER. */
  scopeLocked?: boolean;
}) {
  const t = useTranslations('fees');
  const err = (name: string) => errorOf(state, name);
  const [scope, setScope] = useState<FeeScope>(initial?.scope ?? 'PER_TICKET');
  const [calculation, setCalculation] = useState<FeeCalculation>(initial?.calculation ?? 'FIXED');
  const scopes = FEE_SCOPES.filter((s) => mode === 'global' || s !== 'PER_ORDER');
  const initialValue =
    initial?.value === undefined
      ? ''
      : formatHundredths(initial.value, initial.calculation === 'PERCENT' ? 'percent' : 'money');
  const rateOptions = taxRates.filter((r) => r.isActive || r.id === initial?.taxRateId);
  const methods = initial?.paymentMethods ?? FEE_PAYMENT_METHODS;
  const channels = initial?.channels?.length ? initial.channels : (['ONLINE'] as const);

  return (
    <>
      <Field
        label={t('form.name')}
        htmlFor="fee-name"
        error={err('name')}
        hint={t('form.nameHint')}
      >
        <Input id="fee-name" name="name" defaultValue={initial?.name} required maxLength={120} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label={t('form.scope')}
          htmlFor="fee-scope"
          error={err('scope')}
          hint={scopeLocked && scope !== 'PER_ORDER' ? t('form.scopeLocked') : undefined}
          className="sm:col-span-3"
        >
          <NativeSelect
            id="fee-scope"
            name="scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as FeeScope)}
          >
            {scopes.map((s) => (
              <option
                key={s}
                value={s}
                disabled={s === 'PER_ORDER' && scopeLocked && initial?.scope !== 'PER_ORDER'}
              >
                {t(`scopes.${s}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('form.calculation')} htmlFor="fee-calc" error={err('calculation')}>
          <NativeSelect
            id="fee-calc"
            name="calculation"
            value={calculation}
            onChange={(e) => setCalculation(e.target.value as FeeCalculation)}
          >
            {FEE_CALCULATIONS.map((c) => (
              <option key={c} value={c}>
                {t(`calculations.${c}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label={
            calculation === 'PERCENT' ? t('form.valuePercent') : t('form.valueFixed', { currency })
          }
          htmlFor="fee-value"
          error={err('value')}
        >
          <Input
            id="fee-value"
            name="value"
            inputMode="decimal"
            defaultValue={initialValue}
            required
          />
        </Field>
        <Field
          label={t('form.taxRate')}
          htmlFor="fee-tax"
          error={err('taxRateId')}
          hint={scope === 'PER_ORDER' ? t('form.taxRateRequired') : undefined}
        >
          <NativeSelect id="fee-tax" name="taxRateId" defaultValue={initial?.taxRateId ?? ''}>
            <option value="" disabled={scope === 'PER_ORDER'}>
              {t('form.eventTaxRate')}
            </option>
            {rateOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.isActive ? r.name : t('form.inactiveTaxRate', { name: r.name })}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <CheckboxGroup
        legend={t('form.paymentMethods')}
        name="paymentMethods"
        options={FEE_PAYMENT_METHODS.map((m) => ({ value: m, label: t(`methods.${m}`) }))}
        checked={methods}
        error={err('paymentMethods') ? t('form.selectionRequired') : undefined}
      />
      <CheckboxGroup
        legend={t('form.channels')}
        name="channels"
        options={SALES_CHANNELS.map((c) => ({ value: c, label: t(`channelNames.${c}`) }))}
        checked={channels}
        error={err('channels') ? t('form.selectionRequired') : undefined}
      />
      <p className="text-xs text-muted-foreground">{t('form.allHint')}</p>
      {mode !== 'override' && (
        <div className="flex flex-wrap items-end gap-6">
          <label className="flex items-center gap-3 text-sm">
            <Switch name="isActive" defaultChecked={initial?.isActive ?? true} />
            {t('form.isActive')}
          </label>
          {mode === 'event' && (
            <Field
              label={t('form.sortOrder')}
              htmlFor="fee-sort"
              error={err('sortOrder')}
              className="w-32"
            >
              <Input
                id="fee-sort"
                name="sortOrder"
                type="number"
                defaultValue={initial?.sortOrder ?? ''}
              />
            </Field>
          )}
        </div>
      )}
    </>
  );
}

function CheckboxGroup({
  legend,
  name,
  options,
  checked,
  error,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string }[];
  checked: readonly string[];
  error?: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name={name}
              value={o.value}
              defaultChecked={checked.includes(o.value)}
              className="size-4"
            />
            {o.label}
          </label>
        ))}
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function FeeDialog({
  action,
  mode,
  title,
  description,
  initial,
  taxRates,
  currency,
  scopeLocked,
  trigger,
}: {
  action: Action;
  mode: FeeFormMode;
  title: string;
  description?: ReactNode;
  initial?: Partial<FeeView>;
  taxRates: TaxRateOption[];
  currency: string;
  scopeLocked?: boolean;
  trigger: ReactNode;
}) {
  const tc = useTranslations('common.actions');
  const { open, setOpen, state, formAction } = useDialogAction(action);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <FeeFeedback state={state} />
          <FeeFields
            mode={mode}
            initial={initial}
            taxRates={taxRates}
            currency={currency}
            state={state}
            scopeLocked={scopeLocked}
          />
          <DialogFooter>
            <SubmitButton>{tc('save')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
