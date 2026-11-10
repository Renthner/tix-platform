'use client';

import { accountingPreset, ACCOUNTING_CHARTS, type AccountingChart } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionFeedback, ActionForm, Field, NativeSelect, SubmitButton } from './form-controls';
import { useSettingsForm, type Action } from './settings-forms';

/* Accounting page: export form (range + downloads) and the chart-of-accounts settings form. */

export type RangePresetValues = Record<
  'thisMonth' | 'lastMonth' | 'thisQuarter' | 'lastQuarter' | 'fiscalYear' | 'lastFiscalYear',
  [string, string]
>;

type ExportKind = 'documents' | 'payments' | 'refunds' | 'datev';

interface ApiError {
  error?: { code?: string; details?: Record<string, unknown> };
}

export function AccountingExportForm({
  presets,
  locale,
}: {
  presets: RangePresetValues;
  locale: string;
}) {
  const t = useTranslations('accounting.export');
  const [from, setFrom] = useState(presets.thisMonth[0]);
  const [to, setTo] = useState(presets.thisMonth[1]);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const errorText = (body: ApiError): string => {
    const code = body.error?.code ?? '';
    const d = body.error?.details ?? {};
    switch (code) {
      case 'ACCOUNTING_RANGE_INVALID':
      case 'ACCOUNTING_DATEV_MASTER_DATA_MISSING':
        return t(`errors.${code}`);
      case 'ACCOUNTING_FISCAL_YEAR_SPAN':
        return t('errors.ACCOUNTING_FISCAL_YEAR_SPAN', {
          start: String(d.fiscalYearStart ?? ''),
          end: String(d.fiscalYearEnd ?? ''),
        });
      case 'ACCOUNTING_ACCOUNT_MISSING':
        return t('errors.ACCOUNTING_ACCOUNT_MISSING', {
          rates: ((d.rateBasisPoints as number[] | undefined) ?? [])
            .map((bp) => `${bp / 100} %`)
            .join(', '),
        });
      case 'ACCOUNTING_CURRENCY':
        return t('errors.ACCOUNTING_CURRENCY', { currency: String(d.currency ?? '') });
      case 'ACCOUNTING_DOCUMENT_MISMATCH':
        return t('errors.ACCOUNTING_DOCUMENT_MISMATCH', { number: String(d.number ?? '') });
      default:
        return t('errors.generic');
    }
  };

  async function download(kind: ExportKind) {
    setBusy(kind);
    setError(null);
    try {
      const params = new URLSearchParams({ kind, from, to, locale });
      const response = await fetch(`/api/admin/accounting/export?${params}`);
      if (!response.ok) {
        setError(errorText((await response.json().catch(() => ({}))) as ApiError));
        return;
      }
      const blob = await response.blob();
      const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = match?.[1] ?? `accounting-${kind}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(t('done', { rows: response.headers.get('x-export-rows') ?? '0' }));
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  }

  const button = (kind: ExportKind, label: string, variant: 'default' | 'outline' = 'outline') => (
    <Button
      key={kind}
      type="button"
      variant={variant}
      disabled={busy !== null || !from || !to}
      onClick={() => download(kind)}
    >
      {busy === kind ? t('preparing') : label}
    </Button>
  );

  return (
    <div className="space-y-5">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('from')} htmlFor="export-from">
          <Input
            id="export-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label={t('to')} htmlFor="export-to">
          <Input
            id="export-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{t('presetsLabel')}:</span>
        {(Object.keys(presets) as (keyof RangePresetValues)[]).map((key) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setFrom(presets[key][0]);
              setTo(presets[key][1]);
            }}
          >
            {t(`presets.${key}`)}
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('datevTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('datevHint')}</p>
        <div>{button('datev', t('datev'), 'default')}</div>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('csvTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('csvHint')}</p>
        <div className="flex flex-wrap gap-2">
          {button('documents', t('documents'))}
          {button('payments', t('payments'))}
          {button('refunds', t('refunds'))}
        </div>
      </div>
    </div>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

export interface AccountingFormValues {
  chart: AccountingChart;
  consultantNumber?: number;
  clientNumber?: number;
  fiscalYearStart: string;
  accountLength: number;
  taxAccounts: {
    rateBasisPoints: number;
    revenueAccount: string;
    feeAccount?: string;
    buKey?: string;
  }[];
  debtorAccount: string;
  bankAccount: string;
  paypalAccount: string;
  cashAccount: string;
  cardAccount: string;
  writeOffAccount: string;
}

interface Row {
  rate: string;
  revenue: string;
  fee: string;
  bu: string;
}

const percentText = (bp: number) => String(bp / 100).replace('.', ',');
const toRows = (taxAccounts: AccountingFormValues['taxAccounts']): Row[] =>
  taxAccounts.map((r) => ({
    rate: percentText(r.rateBasisPoints),
    revenue: r.revenueAccount,
    fee: r.feeAccount ?? '',
    bu: r.buKey ?? '',
  }));

export function AccountingSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: AccountingFormValues;
}) {
  const t = useTranslations('accounting.settings');
  const { state, formAction, err } = useSettingsForm(action);
  const [chart, setChart] = useState<AccountingChart>(initial.chart);
  const [accountLength, setAccountLength] = useState(String(initial.accountLength));
  const [accounts, setAccounts] = useState({
    debtorAccount: initial.debtorAccount,
    bankAccount: initial.bankAccount,
    paypalAccount: initial.paypalAccount,
    cashAccount: initial.cashAccount,
    cardAccount: initial.cardAccount,
    writeOffAccount: initial.writeOffAccount,
  });
  const [rows, setRows] = useState<Row[]>(toRows(initial.taxAccounts));

  const applyPreset = () => {
    const length = Number(accountLength);
    if (!Number.isInteger(length) || length < 4 || length > 8) return;
    const preset = accountingPreset(chart, length);
    setAccounts({
      debtorAccount: preset.debtorAccount,
      bankAccount: preset.bankAccount,
      paypalAccount: preset.paypalAccount,
      cashAccount: preset.cashAccount,
      cardAccount: preset.cardAccount,
      writeOffAccount: preset.writeOffAccount,
    });
    setRows(toRows(preset.taxAccounts));
  };
  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const account = (name: keyof typeof accounts, label: string, hint?: string) => (
    <Field label={label} htmlFor={name} error={err(name)} hint={hint}>
      <Input
        id={name}
        name={name}
        inputMode="numeric"
        maxLength={9}
        value={accounts[name]}
        onChange={(e) => setAccounts((a) => ({ ...a, [name]: e.target.value }))}
        required
      />
    </Field>
  );

  return (
    <ActionForm action={formAction} className="space-y-6">
      <ActionFeedback state={state} />
      <input type="hidden" name="taxRowCount" value={rows.length} />
      <div className="grid gap-4 md:grid-cols-3">
        <Field label={t('chart')} htmlFor="chart" error={err('chart')}>
          <NativeSelect
            id="chart"
            name="chart"
            value={chart}
            onChange={(e) => setChart(e.target.value as AccountingChart)}
          >
            {ACCOUNTING_CHARTS.map((c) => (
              <option key={c} value={c}>
                {t(`chartOptions.${c}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label={t('accountLength')}
          htmlFor="accountLength"
          error={err('accountLength')}
          hint={t('accountLengthHint')}
          className="md:col-span-2"
        >
          <Input
            id="accountLength"
            name="accountLength"
            type="number"
            min={4}
            max={8}
            value={accountLength}
            onChange={(e) => setAccountLength(e.target.value)}
            required
            className="max-w-24"
          />
        </Field>
        <Field
          label={t('consultantNumber')}
          htmlFor="consultantNumber"
          error={err('consultantNumber')}
          hint={t('consultantHint')}
        >
          <Input
            id="consultantNumber"
            name="consultantNumber"
            type="number"
            inputMode="numeric"
            defaultValue={initial.consultantNumber ?? ''}
          />
        </Field>
        <Field
          label={t('clientNumber')}
          htmlFor="clientNumber"
          error={err('clientNumber')}
          hint={t('clientHint')}
        >
          <Input
            id="clientNumber"
            name="clientNumber"
            type="number"
            inputMode="numeric"
            defaultValue={initial.clientNumber ?? ''}
          />
        </Field>
        <Field
          label={t('fiscalYearStart')}
          htmlFor="fiscalYearStart"
          error={err('fiscalYearStart')}
          hint={t('fiscalYearStartHint')}
        >
          <Input
            id="fiscalYearStart"
            name="fiscalYearStart"
            defaultValue={initial.fiscalYearStart}
            pattern="[0-1][0-9]-[0-3][0-9]"
            maxLength={5}
            required
          />
        </Field>
      </div>

      <div>
        <Button type="button" variant="outline" size="sm" onClick={applyPreset}>
          {t('applyPreset')}
        </Button>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t('ratesTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('ratesHint')}</p>
          <p className="text-xs text-muted-foreground">{t('buKeyHint')}</p>
        </div>
        {rows.map((row, i) => (
          <div key={i} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
            <Field label={t('taxRate')} htmlFor={`taxRate_${i}`} error={err(`taxRate_${i}`)}>
              <Input
                id={`taxRate_${i}`}
                name={`taxRate_${i}`}
                inputMode="decimal"
                value={row.rate}
                onChange={(e) => setRow(i, { rate: e.target.value })}
                required
              />
            </Field>
            <Field
              label={t('revenueAccount')}
              htmlFor={`taxRevenue_${i}`}
              error={err(`taxRevenue_${i}`)}
            >
              <Input
                id={`taxRevenue_${i}`}
                name={`taxRevenue_${i}`}
                inputMode="numeric"
                maxLength={9}
                value={row.revenue}
                onChange={(e) => setRow(i, { revenue: e.target.value })}
                required
              />
            </Field>
            <Field
              label={`${t('feeAccount')} (${t('feeAccountHint')})`}
              htmlFor={`taxFee_${i}`}
              error={err(`taxFee_${i}`)}
            >
              <Input
                id={`taxFee_${i}`}
                name={`taxFee_${i}`}
                inputMode="numeric"
                maxLength={9}
                value={row.fee}
                onChange={(e) => setRow(i, { fee: e.target.value })}
              />
            </Field>
            <Field label={t('buKey')} htmlFor={`taxBu_${i}`} error={err(`taxBu_${i}`)}>
              <Input
                id={`taxBu_${i}`}
                name={`taxBu_${i}`}
                inputMode="numeric"
                maxLength={4}
                value={row.bu}
                onChange={(e) => setRow(i, { bu: e.target.value })}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRows((current) => current.filter((_, index) => index !== i))}
            >
              {t('removeRate')}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.length >= 30}
          onClick={() =>
            setRows((current) => [...current, { rate: '', revenue: '', fee: '', bu: '' }])
          }
        >
          {t('addRate')}
        </Button>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t('moneyTitle')}</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {account('debtorAccount', t('debtorAccount'), t('debtorHint'))}
          {account('bankAccount', t('bankAccount'))}
          {account('paypalAccount', t('paypalAccount'))}
          {account('cashAccount', t('cashAccount'))}
          {account('cardAccount', t('cardAccount'))}
          {account('writeOffAccount', t('writeOffAccount'), t('writeOffHint'))}
        </div>
      </div>
      <SubmitButton>{t('save')}</SubmitButton>
    </ActionForm>
  );
}
