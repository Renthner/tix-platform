'use client';

import {
  FEE_CALCULATIONS,
  FEE_SCOPES,
  PAYMENT_METHODS,
  SALES_CHANNELS,
  exampleFeeAmount,
  formatHundredths,
  parseFeeAmountToCents,
  type FeeCalculation,
  type FeeScope,
  type PaymentMethod,
  type SalesChannel,
} from '@tix/shared';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Pencil,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  useActionState,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { IDLE } from '@/lib/action-state';
import { formatMoney } from '@/lib/money';
import type { FeeActionState } from '@/server/admin/fees';
import { ActionForm, Field, NativeSelect, SubmitButton, errorOf } from './form-controls';

type Action = (state: FeeActionState, fd: FormData) => Promise<FeeActionState>;

export interface TaxRateOption {
  id: string;
  name: string;
  rateBasisPoints: number;
  isActive: boolean;
}

export interface TaxRateRowView extends TaxRateOption {
  invoiceNote: string | null;
  isDefault: boolean;
  sortOrder: number;
  eventCount: number;
  feeCount: number;
  save: Action;
  remove: Action;
}

export interface FeeView {
  id: string;
  name: string;
  scope: FeeScope;
  calculation: FeeCalculation;
  value: number;
  taxRateId: string | null;
  paymentMethods: PaymentMethod[] | null;
  channels: SalesChannel[] | null;
  isActive: boolean;
  sortOrder: number;
}

export interface GlobalFeeRowView extends FeeView {
  overrideCount: number;
  waivedCount: number;
  save: Action;
  remove: Action;
}

export interface EventGlobalFeeView {
  global: FeeView;
  override: FeeView | null;
  state: 'INHERITED' | 'OVERRIDDEN' | 'WAIVED';
  effective: FeeView;
  charged: boolean;
  adjust: Action;
  waive: Action;
  reset: Action;
}

export interface EventOwnFeeView extends FeeView {
  save: Action;
  remove: Action;
}

/** Payment methods of the online checkout (used for the example). */
const ONLINE_METHODS = ['PAYPAL', 'BANK_TRANSFER'] as const satisfies readonly PaymentMethod[];

// ─── Formatting helpers ─────────────────────────────────────────────────────

function useFeeFormat(currency: string) {
  const t = useTranslations('fees');
  const locale = useLocale();
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const percent = (bp: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
      bp / 10_000,
    );
  const describe = (fee: Pick<FeeView, 'scope' | 'calculation' | 'value'>) =>
    t(`describe.${fee.scope}.${fee.calculation}`, {
      amount: money(fee.value),
      percent: percent(fee.value),
    });
  const appliesTo = (fee: Pick<FeeView, 'paymentMethods' | 'channels'>) => [
    fee.paymentMethods
      ? fee.paymentMethods.map((m) => t(`methods.${m}`)).join(', ')
      : t('allMethods'),
    (fee.channels?.length ? fee.channels : (['ONLINE'] as const))
      .map((c) => t(`channelNames.${c}`))
      .join(', '),
  ];
  return { money, percent, describe, appliesTo };
}

function taxRateLabel(
  taxRateId: string | null,
  taxRates: TaxRateOption[],
  eventRate: string,
  percent: (bp: number) => string,
): string {
  if (!taxRateId) return eventRate;
  const rate = taxRates.find((r) => r.id === taxRateId);
  return rate ? `${rate.name} (${percent(rate.rateBasisPoints)})` : '–';
}

// ─── Feedback & dialogs ─────────────────────────────────────────────────────

/** Toasts on success; alert for form-level and fee-specific errors (input stays in place). */
function FeeFeedback({ state }: { state: FeeActionState }) {
  const t = useTranslations('fees');
  const ta = useTranslations('admin');
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === lastAt.current) return;
    lastAt.current = state.at;
    if (state.status === 'success') {
      toast.success(
        state.feeMessage
          ? t(`messages.${state.feeMessage}`)
          : ta(`messages.${state.message ?? 'saved'}`),
      );
    } else if (!state.formError && !state.feeError) {
      toast.error(ta('errors.form.validation'));
    }
  }, [state, t, ta]);
  if (state.status !== 'error' || (!state.feeError && !state.formError)) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {state.feeError ? t(`errors.${state.feeError}`) : ta(`errors.form.${state.formError!}`)}
      </AlertDescription>
    </Alert>
  );
}

/** Toast for actions called directly (toggle, reorder). */
function useDirectFeedback() {
  const t = useTranslations('fees');
  const ta = useTranslations('admin');
  return (state: FeeActionState) => {
    if (state.status === 'success') {
      toast.success(
        state.feeMessage
          ? t(`messages.${state.feeMessage}`)
          : ta(`messages.${state.message ?? 'saved'}`),
      );
    } else if (state.status === 'error') {
      toast.error(
        state.feeError
          ? t(`errors.${state.feeError}`)
          : ta(`errors.form.${state.formError ?? 'generic'}`),
      );
    }
  };
}

function useDialogAction(action: Action) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<FeeActionState, FormData>(action, IDLE);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  return { open, setOpen, state, formAction };
}

function TriggerButton({
  icon,
  label,
  primary,
  ...props
}: ComponentProps<typeof Button> & { icon: ReactNode; label: string; primary?: boolean }) {
  return primary ? (
    <Button type="button" size="sm" {...props}>
      {icon} {label}
    </Button>
  ) : (
    <Button
      type="button"
      size="icon-sm"
      variant="outline"
      aria-label={label}
      title={label}
      {...props}
    >
      {icon}
    </Button>
  );
}

/** Confirmation dialog running a bound server action (waive, reset, delete). */
function FeeConfirm({
  action,
  title,
  description,
  confirmLabel,
  trigger,
  destructive = true,
}: {
  action: Action;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  trigger: ReactNode;
  destructive?: boolean;
}) {
  const tc = useTranslations('common.actions');
  const { open, setOpen, state, formAction } = useDialogAction(action);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <FeeFeedback state={state} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tc('cancel')}
            </Button>
            <SubmitButton variant={destructive ? 'destructive' : 'default'}>
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

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
  const methods = initial?.paymentMethods ?? PAYMENT_METHODS;
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
        options={PAYMENT_METHODS.map((m) => ({ value: m, label: t(`methods.${m}`) }))}
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

function FeeDialog({
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

// ─── Tax rates ──────────────────────────────────────────────────────────────

function TaxRateDialog({
  action,
  initial,
  trigger,
}: {
  action: Action;
  initial?: TaxRateRowView;
  trigger: ReactNode;
}) {
  const t = useTranslations('fees.taxRates');
  const tc = useTranslations('common.actions');
  const { open, setOpen, state, formAction } = useDialogAction(action);
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const err = (name: string) => errorOf(state, name);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? t('edit') : t('new')}</DialogTitle>
          {initial && <DialogDescription>{t('rateChangeHint')}</DialogDescription>}
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <FeeFeedback state={state} />
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Field label={t('name')} htmlFor="tax-name" error={err('name')}>
              <Input
                id="tax-name"
                name="name"
                defaultValue={initial?.name}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('rate')} htmlFor="tax-rate" error={err('rate')}>
              <Input
                id="tax-rate"
                name="rate"
                inputMode="decimal"
                defaultValue={
                  initial ? formatHundredths(initial.rateBasisPoints, 'percent') : undefined
                }
                required
              />
            </Field>
          </div>
          <Field
            label={t('invoiceNote')}
            htmlFor="tax-note"
            error={err('invoiceNote')}
            hint={t('invoiceNoteHint')}
          >
            <Textarea
              id="tax-note"
              name="invoiceNote"
              rows={2}
              maxLength={1000}
              defaultValue={initial?.invoiceNote ?? ''}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-6">
            <label className="flex items-center gap-3 text-sm">
              <Switch name="isDefault" checked={isDefault} onCheckedChange={setIsDefault} />
              {t('isDefault')}
            </label>
            <Field
              label={t('sortOrder')}
              htmlFor="tax-sort"
              error={err('sortOrder')}
              className="w-32"
            >
              <Input
                id="tax-sort"
                name="sortOrder"
                type="number"
                defaultValue={initial?.sortOrder ?? 0}
              />
            </Field>
          </div>
          <div className="space-y-1">
            <label className="flex items-center gap-3 text-sm">
              {isDefault ? (
                <>
                  <Switch checked disabled aria-readonly />
                  <input type="hidden" name="isActive" value="on" />
                </>
              ) : (
                <Switch name="isActive" defaultChecked={initial?.isActive ?? true} />
              )}
              {t('isActive')}
            </label>
            {(isDefault || err('isActive')) && (
              <p
                className={
                  err('isActive') ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                }
              >
                {t('defaultMustBeActive')}
              </p>
            )}
          </div>
          <DialogFooter>
            <SubmitButton>{tc('save')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function TaxRatesSection({
  currency,
  taxRates,
  canEdit,
  create,
}: {
  currency: string;
  taxRates: TaxRateRowView[];
  canEdit: boolean;
  create: Action;
}) {
  const t = useTranslations('fees');
  const tc = useTranslations('common.actions');
  const { percent } = useFeeFormat(currency);
  return (
    <Section
      title={t('taxRates.title')}
      description={t('taxRates.description')}
      action={
        canEdit && (
          <TaxRateDialog
            action={create}
            trigger={<TriggerButton primary icon={<Plus />} label={t('taxRates.new')} />}
          />
        )
      }
    >
      {taxRates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('taxRates.empty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('taxRates.name')}</TableHead>
              <TableHead className="text-right">{t('taxRates.rateColumn')}</TableHead>
              <TableHead>{t('taxRates.invoiceNote')}</TableHead>
              <TableHead>{t('taxRates.usage')}</TableHead>
              {canEdit && <TableHead className="text-right">{t('actions')}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {taxRates.map((r) => {
              const inUse = r.eventCount > 0 || r.feeCount > 0;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {r.name}
                      {r.isDefault && <Badge variant="secondary">{t('taxRates.default')}</Badge>}
                      {!r.isActive && <Badge variant="outline">{t('inactive')}</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percent(r.rateBasisPoints)}
                  </TableCell>
                  <TableCell
                    className="max-w-72 truncate text-muted-foreground"
                    title={r.invoiceNote ?? undefined}
                  >
                    {r.invoiceNote ?? '–'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t('taxRates.usageValue', { events: r.eventCount, fees: r.feeCount })}
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <TaxRateDialog
                          action={r.save}
                          initial={r}
                          trigger={<TriggerButton icon={<Pencil />} label={tc('edit')} />}
                        />
                        <FeeConfirm
                          action={r.remove}
                          title={t('taxRates.deleteTitle')}
                          description={t('taxRates.deleteDescription', { name: r.name })}
                          confirmLabel={t('delete')}
                          trigger={
                            <TriggerButton
                              icon={<Trash2 />}
                              label={inUse ? t('taxRates.inUseHint') : t('delete')}
                              disabled={inUse}
                            />
                          }
                        />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

// ─── Global fees page ───────────────────────────────────────────────────────

export function FeesAdmin({
  currency,
  canEdit,
  taxRates,
  fees,
  createTaxRate,
  createFee,
  setFeeActive,
  reorderFees,
}: {
  currency: string;
  canEdit: boolean;
  taxRates: TaxRateRowView[];
  fees: GlobalFeeRowView[];
  createTaxRate: Action;
  createFee: Action;
  setFeeActive: (feeId: string, isActive: boolean) => Promise<FeeActionState>;
  reorderFees: (orderedIds: string[]) => Promise<FeeActionState>;
}) {
  const t = useTranslations('fees');
  const tc = useTranslations('common.actions');
  const fmt = useFeeFormat(currency);
  const feedback = useDirectFeedback();
  const [pending, startTransition] = useTransition();

  const move = (index: number, delta: -1 | 1) => {
    const ids = fees.map((f) => f.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    startTransition(async () => feedback(await reorderFees(ids)));
  };

  return (
    <div className="space-y-8">
      {!canEdit && (
        <Alert>
          <AlertDescription>{t('readOnly')}</AlertDescription>
        </Alert>
      )}
      <HowItWorks />
      <TaxRatesSection
        currency={currency}
        taxRates={taxRates}
        canEdit={canEdit}
        create={createTaxRate}
      />
      <Section
        title={t('global.title')}
        description={t('global.description')}
        action={
          canEdit && (
            <FeeDialog
              action={createFee}
              mode="global"
              title={t('global.new')}
              taxRates={taxRates}
              currency={currency}
              trigger={<TriggerButton primary icon={<Plus />} label={t('global.new')} />}
            />
          )
        }
      >
        {fees.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('global.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {canEdit && <TableHead className="w-20" />}
                <TableHead>{t('form.name')}</TableHead>
                <TableHead>{t('form.scope')}</TableHead>
                <TableHead>{t('appliesTo')}</TableHead>
                <TableHead>{t('taxRateColumn')}</TableHead>
                <TableHead>{t('global.adjustments')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                {canEdit && <TableHead className="text-right">{t('actions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {fees.map((f, index) => (
                <TableRow key={f.id}>
                  {canEdit && (
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={pending || index === 0}
                          onClick={() => move(index, -1)}
                          aria-label={t('moveUp')}
                          title={t('moveUp')}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={pending || index === fees.length - 1}
                          onClick={() => move(index, 1)}
                          aria-label={t('moveDown')}
                          title={t('moveDown')}
                        >
                          <ArrowDown />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell>{fmt.describe(f)}</TableCell>
                  <TableCell className="text-xs">
                    {fmt.appliesTo(f).map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </TableCell>
                  <TableCell className="text-sm">
                    {taxRateLabel(f.taxRateId, taxRates, t('eventTaxRateShort'), fmt.percent)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {adjustmentSummary(f, t)}
                  </TableCell>
                  <TableCell>
                    {canEdit ? (
                      <ActiveToggle fee={f} setActive={setFeeActive} />
                    ) : f.isActive ? (
                      t('active')
                    ) : (
                      <Badge variant="outline">{t('inactive')}</Badge>
                    )}
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <FeeDialog
                          action={f.save}
                          mode="global"
                          title={t('global.edit')}
                          initial={f}
                          taxRates={taxRates}
                          currency={currency}
                          scopeLocked={f.overrideCount + f.waivedCount > 0}
                          trigger={<TriggerButton icon={<Pencil />} label={tc('edit')} />}
                        />
                        <FeeConfirm
                          action={f.remove}
                          title={t('global.deleteTitle')}
                          description={
                            <>
                              {t('global.deleteDescription', { name: f.name })}
                              {f.overrideCount + f.waivedCount > 0 && (
                                <>
                                  {' '}
                                  {t('global.deleteOverrides', {
                                    count: f.overrideCount + f.waivedCount,
                                  })}
                                </>
                              )}
                            </>
                          }
                          confirmLabel={t('delete')}
                          trigger={<TriggerButton icon={<Trash2 />} label={t('delete')} />}
                        />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      <FeeExample
        currency={currency}
        defaultTicketPrice={3000}
        eventFees={fees.filter((f) => f.scope !== 'PER_ORDER' && f.isActive)}
        orderFees={fees.filter((f) => f.scope === 'PER_ORDER' && f.isActive)}
      />
    </div>
  );
}

function adjustmentSummary(
  fee: Pick<GlobalFeeRowView, 'overrideCount' | 'waivedCount'>,
  t: ReturnType<typeof useTranslations<'fees'>>,
): string {
  const parts = [
    fee.overrideCount > 0 ? t('global.adjusted', { count: fee.overrideCount }) : null,
    fee.waivedCount > 0 ? t('global.waived', { count: fee.waivedCount }) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '–';
}

function ActiveToggle({
  fee,
  setActive,
}: {
  fee: GlobalFeeRowView;
  setActive: (feeId: string, isActive: boolean) => Promise<FeeActionState>;
}) {
  const t = useTranslations('fees');
  const feedback = useDirectFeedback();
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useOptimistic(fee.isActive);
  return (
    <Switch
      checked={checked}
      disabled={pending}
      aria-label={t('global.toggleActive')}
      title={t('global.toggleActive')}
      onCheckedChange={(value) =>
        startTransition(async () => {
          setChecked(value);
          feedback(await setActive(fee.id, value));
        })
      }
    />
  );
}

function HowItWorks() {
  const t = useTranslations('fees.howItWorks');
  return (
    <Section title={t('title')}>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t('perTicket')}</li>
        <li>{t('perEvent')}</li>
        <li>{t('perOrder')}</li>
        <li>{t('filters')}</li>
        <li>{t('events')}</li>
        <li>{t('snapshots')}</li>
      </ul>
    </Section>
  );
}

// ─── Event tab ──────────────────────────────────────────────────────────────

export function EventFeesManager({
  currency,
  taxRates,
  eventTaxRateName,
  globals,
  orderFees,
  own,
  createOwn,
  defaultTicketPrice,
}: {
  currency: string;
  taxRates: TaxRateOption[];
  eventTaxRateName: string;
  globals: EventGlobalFeeView[];
  orderFees: FeeView[];
  own: EventOwnFeeView[];
  createOwn: Action;
  defaultTicketPrice: number;
}) {
  const t = useTranslations('fees');
  const tc = useTranslations('common.actions');
  const fmt = useFeeFormat(currency);
  const rateOf = (fee: FeeView) =>
    taxRateLabel(fee.taxRateId, taxRates, eventTaxRateName, fmt.percent);

  return (
    <div className="space-y-8">
      <Section
        title={t('event.globalTitle')}
        description={t('event.globalDescription')}
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/fees">{t('event.manageGlobal')}</Link>
          </Button>
        }
      >
        {globals.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('event.globalEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('form.name')}</TableHead>
                <TableHead>{t('form.scope')}</TableHead>
                <TableHead>{t('appliesTo')}</TableHead>
                <TableHead>{t('taxRateColumn')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead className="text-right">{t('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {globals.map((g) => {
                const shown = g.state === 'WAIVED' ? g.global : g.effective;
                return (
                  <TableRow key={g.global.id} className={g.charged ? undefined : 'opacity-70'}>
                    <TableCell className="font-medium">{shown.name}</TableCell>
                    <TableCell>
                      <span className={g.state === 'WAIVED' ? 'line-through' : undefined}>
                        {fmt.describe(shown)}
                      </span>
                      {g.state === 'OVERRIDDEN' && (
                        <span className="block text-xs text-muted-foreground">
                          {t('event.globalValue', { value: fmt.describe(g.global) })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {fmt.appliesTo(shown).map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </TableCell>
                    <TableCell className="text-sm">{rateOf(shown)}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        <Badge
                          variant={
                            g.state === 'INHERITED'
                              ? 'secondary'
                              : g.state === 'OVERRIDDEN'
                                ? 'default'
                                : 'outline'
                          }
                        >
                          {t(`event.states.${g.state}`)}
                        </Badge>
                        {g.state === 'INHERITED' && !g.global.isActive && (
                          <Badge variant="outline">{t('event.states.globallyInactive')}</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <FeeDialog
                          action={g.adjust}
                          mode="override"
                          title={t('event.adjustTitle', { name: g.global.name })}
                          description={
                            <>
                              {t('event.adjustDescription')}{' '}
                              {t('event.globalValue', { value: fmt.describe(g.global) })}
                            </>
                          }
                          initial={g.override ?? g.global}
                          taxRates={taxRates}
                          currency={currency}
                          trigger={
                            <TriggerButton icon={<SlidersHorizontal />} label={t('event.adjust')} />
                          }
                        />
                        {g.state !== 'WAIVED' && (
                          <FeeConfirm
                            action={g.waive}
                            title={t('event.waiveTitle', { name: g.global.name })}
                            description={t('event.waiveDescription')}
                            confirmLabel={t('event.waive')}
                            trigger={<TriggerButton icon={<Ban />} label={t('event.waive')} />}
                          />
                        )}
                        {g.override && (
                          <FeeConfirm
                            action={g.reset}
                            title={t('event.resetTitle', { name: g.global.name })}
                            description={t('event.resetDescription')}
                            confirmLabel={t('event.reset')}
                            destructive={false}
                            trigger={
                              <TriggerButton icon={<RotateCcw />} label={t('event.reset')} />
                            }
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title={t('event.ownTitle')}
        description={t('event.ownDescription')}
        action={
          <FeeDialog
            action={createOwn}
            mode="event"
            title={t('event.newOwn')}
            taxRates={taxRates}
            currency={currency}
            trigger={<TriggerButton primary icon={<Plus />} label={t('event.newOwn')} />}
          />
        }
      >
        {own.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('event.ownEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('form.name')}</TableHead>
                <TableHead>{t('form.scope')}</TableHead>
                <TableHead>{t('appliesTo')}</TableHead>
                <TableHead>{t('taxRateColumn')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead className="text-right">{t('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {own.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell>{fmt.describe(f)}</TableCell>
                  <TableCell className="text-xs">
                    {fmt.appliesTo(f).map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </TableCell>
                  <TableCell className="text-sm">{rateOf(f)}</TableCell>
                  <TableCell>
                    {f.isActive ? t('active') : <Badge variant="outline">{t('inactive')}</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <FeeDialog
                        action={f.save}
                        mode="event"
                        title={t('event.editOwn')}
                        initial={f}
                        taxRates={taxRates}
                        currency={currency}
                        trigger={<TriggerButton icon={<Pencil />} label={tc('edit')} />}
                      />
                      <FeeConfirm
                        action={f.remove}
                        title={t('event.deleteTitle')}
                        description={t('event.deleteDescription', { name: f.name })}
                        confirmLabel={t('delete')}
                        trigger={<TriggerButton icon={<Trash2 />} label={t('delete')} />}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {orderFees.length > 0 && (
        <Section title={t('event.orderFeesTitle')} description={t('event.orderFeesDescription')}>
          <ul className="space-y-1 text-sm">
            {orderFees.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{f.name}</span>
                <span className="text-muted-foreground">{fmt.describe(f)}</span>
                {!f.isActive && <Badge variant="outline">{t('inactive')}</Badge>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <FeeExample
        currency={currency}
        defaultTicketPrice={defaultTicketPrice}
        eventFees={[
          ...globals.filter((g) => g.charged).map((g) => g.effective),
          ...own.filter((f) => f.isActive),
        ]}
        orderFees={orderFees.filter((f) => f.isActive)}
      />
    </div>
  );
}

// ─── Example ────────────────────────────────────────────────────────────────

/**
 * Live preview of an online order for one event: fees per online payment method, computed
 * like the checkout (event fees in their order, then the order fees).
 */
function FeeExample({
  currency,
  defaultTicketPrice,
  eventFees,
  orderFees,
}: {
  currency: string;
  defaultTicketPrice: number;
  eventFees: FeeView[];
  orderFees: FeeView[];
}) {
  const t = useTranslations('fees');
  const fmt = useFeeFormat(currency);
  const [priceInput, setPriceInput] = useState(formatHundredths(defaultTicketPrice, 'money'));
  const [count, setCount] = useState(2);
  const price = parseFeeAmountToCents(priceInput);
  const tickets = Math.min(Math.max(Number.isInteger(count) ? count : 1, 1), 50);
  const fees = [...[...eventFees].sort((a, b) => a.sortOrder - b.sortOrder), ...orderFees].filter(
    (f) => (f.channels?.length ? f.channels : ['ONLINE']).includes('ONLINE'),
  );
  const amountFor = (fee: FeeView, method: PaymentMethod) =>
    price === null || (fee.paymentMethods && !fee.paymentMethods.includes(method))
      ? null
      : exampleFeeAmount(fee, price, tickets);
  const ticketTotal = price === null ? 0 : price * tickets;

  return (
    <Section title={t('example.title')} description={t('example.description')}>
      <div className="flex flex-wrap gap-3">
        <Field
          label={t('example.ticketPrice', { currency })}
          htmlFor="example-price"
          className="w-40"
        >
          <Input
            id="example-price"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
          />
        </Field>
        <Field label={t('example.tickets')} htmlFor="example-count" className="w-28">
          <Input
            id="example-count"
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </Field>
      </div>
      {price === null ? (
        <p className="text-sm text-destructive">{t('example.invalidPrice')}</p>
      ) : (
        <>
          <p className="text-sm">
            {t('example.summary', { count: tickets, price: fmt.money(price) })}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                {ONLINE_METHODS.map((m) => (
                  <TableHead key={m} className="text-right">
                    {t(`methods.${m}`)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>{t('example.ticketsLine')}</TableCell>
                {ONLINE_METHODS.map((m) => (
                  <TableCell key={m} className="text-right tabular-nums">
                    {fmt.money(ticketTotal)}
                  </TableCell>
                ))}
              </TableRow>
              {fees.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    {f.name}
                    <span className="block text-xs text-muted-foreground">{fmt.describe(f)}</span>
                  </TableCell>
                  {ONLINE_METHODS.map((m) => {
                    const amount = amountFor(f, m);
                    return (
                      <TableCell key={m} className="text-right tabular-nums">
                        {amount === null ? '–' : fmt.money(amount)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {fees.length === 0 && (
                <TableRow>
                  <TableCell colSpan={ONLINE_METHODS.length + 1} className="text-muted-foreground">
                    {t('example.noFees')}
                  </TableCell>
                </TableRow>
              )}
              <TableRow className="font-medium">
                <TableCell>{t('example.total')}</TableCell>
                {ONLINE_METHODS.map((m) => (
                  <TableCell key={m} className="text-right tabular-nums">
                    {fmt.money(fees.reduce((sum, f) => sum + (amountFor(f, m) ?? 0), ticketTotal))}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </>
      )}
    </Section>
  );
}
