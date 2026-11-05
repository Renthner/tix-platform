'use client';

import {
  DISCOUNT_KINDS,
  SALES_CHANNELS,
  SEAT_FEATURES,
  computeTicketPrice,
  type CategoryTariffOverride,
  type DiscountKind,
  type SalesChannel,
  type SeatFeature,
} from '@tix/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useActionState, useEffect, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  basisPointsToInput,
  centsToInput,
  formatMoney,
  parseMoneyToCents,
  parsePercentToBasisPoints,
} from '@/lib/money';
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

export interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  basePrice: number;
  maxTicketsPerOrder: number | null;
  sortOrder: number;
  isActive: boolean;
  save: Action;
  remove: Action;
}

export interface TicketTypeRow {
  id: string;
  name: string;
  description: string | null;
  discountKind: DiscountKind;
  discountValue: number;
  requiresProofAtEntry: boolean;
  scannerWarning: string | null;
  requiredSeatFeature: SeatFeature | null;
  maxPerOrder: number | null;
  channels: SalesChannel[];
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  save: Action;
  remove: Action;
}

export interface MatrixCell {
  priceCategoryId: string;
  ticketTypeId: string;
  priceOverride: number | null;
  discountKind: DiscountKind | null;
  discountValue: number | null;
  isActive: boolean;
}

export function PricingManager({
  currency,
  categories,
  ticketTypes,
  matrix,
  createCategory,
  createTicketType,
  saveMatrix,
}: {
  currency: string;
  categories: CategoryRow[];
  ticketTypes: TicketTypeRow[];
  matrix: MatrixCell[];
  createCategory: Action;
  createTicketType: Action;
  saveMatrix: Action;
}) {
  const t = useTranslations('admin.pricing');
  const locale = useLocale();
  const money = (cents: number) => formatMoney(cents, currency, locale);

  return (
    <div className="space-y-8">
      <Section
        title={t('categories.title')}
        description={t('categories.description')}
        action={
          <CategoryDialog
            action={createCategory}
            trigger={
              <>
                <Plus /> {t('categories.new')}
              </>
            }
          />
        }
      >
        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('categories.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('categories.name')}</TableHead>
                <TableHead className="text-right">{t('categories.basePrice')}</TableHead>
                <TableHead className="text-right">{t('categories.maxPerOrder')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead className="text-right">{t('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className="size-3 rounded-full border"
                        style={{ backgroundColor: c.color }}
                        aria-hidden
                      />
                      {c.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(c.basePrice)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.maxTicketsPerOrder ?? '–'}
                  </TableCell>
                  <TableCell>
                    {c.isActive ? t('active') : <Badge variant="outline">{t('inactive')}</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <CategoryDialog action={c.save} initial={c} trigger={<Pencil />} />
                      <ConfirmAction
                        action={c.remove}
                        title={t('categories.deleteTitle')}
                        description={t('categories.deleteDescription', { name: c.name })}
                        confirmLabel={t('delete')}
                        size="icon-sm"
                        label={t('delete')}
                      >
                        <Trash2 />
                      </ConfirmAction>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title={t('types.title')}
        description={t('types.description')}
        action={
          <TicketTypeDialog
            action={createTicketType}
            trigger={
              <>
                <Plus /> {t('types.new')}
              </>
            }
          />
        }
      >
        {ticketTypes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('types.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('types.name')}</TableHead>
                <TableHead>{t('types.discount')}</TableHead>
                <TableHead>{t('types.proof')}</TableHead>
                <TableHead>{t('types.channels')}</TableHead>
                <TableHead className="text-right">{t('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ticketTypes.map((tt) => (
                <TableRow key={tt.id}>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {tt.name}
                      {tt.isDefault && <Badge variant="secondary">{t('types.default')}</Badge>}
                      {!tt.isActive && <Badge variant="outline">{t('inactive')}</Badge>}
                      {tt.requiredSeatFeature && (
                        <Badge variant="outline">
                          {t(`types.features.${tt.requiredSeatFeature}`)}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>{describeDiscount(tt, money, t)}</TableCell>
                  <TableCell className="max-w-48 truncate text-muted-foreground">
                    {tt.requiresProofAtEntry ? tt.scannerWarning : '–'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {tt.channels.map((c) => t(`types.channelNames.${c}`)).join(', ')}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <TicketTypeDialog action={tt.save} initial={tt} trigger={<Pencil />} />
                      <ConfirmAction
                        action={tt.remove}
                        title={t('types.deleteTitle')}
                        description={t('types.deleteDescription', { name: tt.name })}
                        confirmLabel={t('delete')}
                        size="icon-sm"
                        label={t('delete')}
                      >
                        <Trash2 />
                      </ConfirmAction>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {categories.length > 0 && ticketTypes.length > 0 && (
        <Section title={t('matrix.title')} description={t('matrix.description')}>
          <MatrixForm
            action={saveMatrix}
            categories={categories}
            ticketTypes={ticketTypes}
            matrix={matrix}
            money={money}
          />
        </Section>
      )}
    </div>
  );
}

function describeDiscount(
  tt: Pick<TicketTypeRow, 'discountKind' | 'discountValue'>,
  money: (c: number) => string,
  t: ReturnType<typeof useTranslations<'admin.pricing'>>,
): string {
  switch (tt.discountKind) {
    case 'NONE':
      return t('types.kinds.NONE');
    case 'PERCENT':
      return t('types.discountPercent', { value: basisPointsToInput(tt.discountValue) });
    case 'FIXED_AMOUNT':
      return t('types.discountAmount', { value: money(tt.discountValue) });
    case 'FIXED_PRICE':
      return t('types.discountFixed', { value: money(tt.discountValue) });
  }
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
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

function useDialogAction(action: Action) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, IDLE);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  return { open, setOpen, state, formAction };
}

function CategoryDialog({
  action,
  initial,
  trigger,
}: {
  action: Action;
  initial?: CategoryRow;
  trigger: ReactNode;
}) {
  const t = useTranslations('admin.pricing');
  const tc = useTranslations('common.actions');
  const { open, setOpen, state, formAction } = useDialogAction(action);
  const err = (n: string) => errorOf(state, n);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size={initial ? 'icon-sm' : 'sm'}
          variant={initial ? 'outline' : 'default'}
          aria-label={initial ? tc('edit') : undefined}
          title={initial ? tc('edit') : undefined}
        >
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? t('categories.edit') : t('categories.new')}</DialogTitle>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
            <Field label={t('categories.name')} htmlFor="cat-name" error={err('name')}>
              <Input
                id="cat-name"
                name="name"
                defaultValue={initial?.name}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('categories.color')} htmlFor="cat-color" error={err('color')}>
              <Input
                id="cat-color"
                name="color"
                type="color"
                defaultValue={initial?.color ?? '#2563EB'}
                className="p-1"
              />
            </Field>
          </div>
          <Field
            label={t('categories.descriptionField')}
            htmlFor="cat-desc"
            error={err('description')}
          >
            <Textarea
              id="cat-desc"
              name="description"
              rows={2}
              defaultValue={initial?.description ?? ''}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('categories.basePrice')} htmlFor="cat-price" error={err('basePrice')}>
              <Input
                id="cat-price"
                name="basePrice"
                inputMode="decimal"
                defaultValue={centsToInput(initial?.basePrice)}
                required
              />
            </Field>
            <Field
              label={t('categories.maxPerOrder')}
              htmlFor="cat-max"
              error={err('maxTicketsPerOrder')}
            >
              <Input
                id="cat-max"
                name="maxTicketsPerOrder"
                type="number"
                min={1}
                defaultValue={initial?.maxTicketsPerOrder ?? ''}
              />
            </Field>
            <Field label={t('sortOrder')} htmlFor="cat-sort" error={err('sortOrder')}>
              <Input
                id="cat-sort"
                name="sortOrder"
                type="number"
                defaultValue={initial?.sortOrder ?? 0}
              />
            </Field>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Switch name="isActive" defaultChecked={initial?.isActive ?? true} />
            {t('active')}
          </label>
          <DialogFooter>
            <SubmitButton>{tc('save')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function TicketTypeDialog({
  action,
  initial,
  trigger,
}: {
  action: Action;
  initial?: TicketTypeRow;
  trigger: ReactNode;
}) {
  const t = useTranslations('admin.pricing.types');
  const tp = useTranslations('admin.pricing');
  const tc = useTranslations('common.actions');
  const { open, setOpen, state, formAction } = useDialogAction(action);
  const [kind, setKind] = useState<DiscountKind>(initial?.discountKind ?? 'NONE');
  const [proof, setProof] = useState(initial?.requiresProofAtEntry ?? false);
  const err = (n: string) => errorOf(state, n);
  const initialValue = !initial
    ? ''
    : initial.discountKind === 'PERCENT'
      ? basisPointsToInput(initial.discountValue)
      : initial.discountKind === 'NONE'
        ? ''
        : centsToInput(initial.discountValue);
  const channels = initial?.channels ?? [...SALES_CHANNELS];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size={initial ? 'icon-sm' : 'sm'}
          variant={initial ? 'outline' : 'default'}
          aria-label={initial ? tc('edit') : undefined}
          title={initial ? tc('edit') : undefined}
        >
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? t('edit') : t('new')}</DialogTitle>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <Field label={t('name')} htmlFor="tt-name" error={err('name')}>
            <Input id="tt-name" name="name" defaultValue={initial?.name} required maxLength={120} />
          </Field>
          <Field label={t('descriptionField')} htmlFor="tt-desc" error={err('description')}>
            <Textarea
              id="tt-desc"
              name="description"
              rows={2}
              defaultValue={initial?.description ?? ''}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('discountKind')} htmlFor="tt-kind" error={err('discountKind')}>
              <NativeSelect
                id="tt-kind"
                name="discountKind"
                value={kind}
                onChange={(e) => setKind(e.target.value as DiscountKind)}
              >
                {DISCOUNT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`kinds.${k}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t(`valueLabel.${kind}`)} htmlFor="tt-value" error={err('discountValue')}>
              <Input
                id="tt-value"
                name="discountValue"
                inputMode="decimal"
                defaultValue={initialValue}
                disabled={kind === 'NONE'}
              />
            </Field>
          </div>
          <div className="space-y-3 rounded-lg border p-3">
            <label className="flex items-start gap-3 text-sm">
              <Switch
                name="requiresProofAtEntry"
                checked={proof}
                onCheckedChange={setProof}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{t('requiresProof')}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('requiresProofHint')}
                </span>
              </span>
            </label>
            {proof && (
              <Field label={t('scannerWarning')} htmlFor="tt-warning" error={err('scannerWarning')}>
                <Input
                  id="tt-warning"
                  name="scannerWarning"
                  defaultValue={initial?.scannerWarning ?? ''}
                  placeholder={t('scannerWarningPlaceholder')}
                  maxLength={200}
                />
              </Field>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('seatFeature')} htmlFor="tt-feature" error={err('requiredSeatFeature')}>
              <NativeSelect
                id="tt-feature"
                name="requiredSeatFeature"
                defaultValue={initial?.requiredSeatFeature ?? ''}
              >
                <option value="">{t('features.none')}</option>
                {SEAT_FEATURES.map((f) => (
                  <option key={f} value={f}>
                    {t(`features.${f}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('maxPerOrder')} htmlFor="tt-max" error={err('maxPerOrder')}>
              <Input
                id="tt-max"
                name="maxPerOrder"
                type="number"
                min={1}
                defaultValue={initial?.maxPerOrder ?? ''}
              />
            </Field>
            <Field label={tp('sortOrder')} htmlFor="tt-sort" error={err('sortOrder')}>
              <Input
                id="tt-sort"
                name="sortOrder"
                type="number"
                defaultValue={initial?.sortOrder ?? 0}
              />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('channels')}</legend>
            <div className="flex flex-wrap gap-4">
              {SALES_CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="channels"
                    value={c}
                    defaultChecked={channels.includes(c)}
                    className="size-4"
                  />
                  {t(`channelNames.${c}`)}
                </label>
              ))}
            </div>
            {err('channels') && <p className="text-xs text-destructive">{t('channelsRequired')}</p>}
          </fieldset>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-3 text-sm">
              <Switch name="isDefault" defaultChecked={initial?.isDefault ?? false} />
              {t('isDefault')}
            </label>
            <label className="flex items-center gap-3 text-sm">
              <Switch name="isActive" defaultChecked={initial?.isActive ?? true} />
              {tp('active')}
            </label>
          </div>
          <DialogFooter>
            <SubmitButton>{tc('save')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

type CellMode = 'default' | 'price' | 'amount' | 'percent';
interface CellState {
  offered: boolean;
  mode: CellMode;
  value: string;
}

function initialCell(m: MatrixCell | undefined): CellState {
  if (!m) return { offered: false, mode: 'default', value: '' };
  if (m.priceOverride !== null) {
    return { offered: m.isActive, mode: 'price', value: centsToInput(m.priceOverride) };
  }
  if (m.discountKind === 'PERCENT' && m.discountValue !== null) {
    return { offered: m.isActive, mode: 'percent', value: basisPointsToInput(m.discountValue) };
  }
  if (m.discountKind === 'FIXED_AMOUNT' && m.discountValue !== null) {
    return { offered: m.isActive, mode: 'amount', value: centsToInput(m.discountValue) };
  }
  return { offered: m.isActive, mode: 'default', value: '' };
}

/** Cell → override object of computeTicketPrice; undefined = tariff default, null = invalid input. */
function cellOverride(cell: CellState): CategoryTariffOverride | undefined | null {
  if (cell.mode === 'default') return undefined;
  if (cell.mode === 'percent') {
    const bp = parsePercentToBasisPoints(cell.value);
    return bp === null ? null : { discountKind: 'PERCENT', discountValue: bp };
  }
  const cents = parseMoneyToCents(cell.value);
  if (cents === null) return null;
  return cell.mode === 'price'
    ? { priceOverride: cents }
    : { discountKind: 'FIXED_AMOUNT', discountValue: cents };
}

const CELL_MODES = ['default', 'price', 'amount', 'percent'] as const;

function MatrixForm({
  action,
  categories,
  ticketTypes,
  matrix,
  money,
}: {
  action: Action;
  categories: CategoryRow[];
  ticketTypes: TicketTypeRow[];
  matrix: MatrixCell[];
  money: (cents: number) => string;
}) {
  const t = useTranslations('admin.pricing.matrix');
  const tp = useTranslations('admin.pricing');
  const tc = useTranslations('common.actions');
  const [state, formAction] = useActionState(action, IDLE);
  const key = (c: string, tt: string) => `${c}:${tt}`;
  const [cells, setCells] = useState<Record<string, CellState>>(() =>
    Object.fromEntries(matrix.map((m) => [key(m.priceCategoryId, m.ticketTypeId), initialCell(m)])),
  );
  // New categories / tariffs: the server adds their matrix cells (offered by default). Pick
  // those up when the server data changes – without discarding unsaved edits of other cells.
  const [seenMatrix, setSeenMatrix] = useState(matrix);
  if (seenMatrix !== matrix) {
    setSeenMatrix(matrix);
    setCells((all) => {
      const next = { ...all };
      for (const m of matrix) {
        const k = key(m.priceCategoryId, m.ticketTypeId);
        if (!(k in next)) next[k] = initialCell(m);
      }
      return next;
    });
  }
  const currencySymbol = money(0).replace(/[ds., -]/g, '') || '€';
  const update = (k: string, patch: Partial<CellState>) =>
    setCells((all) => ({ ...all, [k]: { ...(all[k] ?? initialCell(undefined)), ...patch } }));

  return (
    <ActionForm action={formAction} className="space-y-4">
      <ActionFeedback state={state} />
      <p className="text-xs text-muted-foreground">{t('modesHint')}</p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('category')}</TableHead>
              {ticketTypes.map((tt) => (
                <TableHead key={tt.id} className="min-w-64 align-top">
                  {tt.name}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t('tariffDefault', { rule: describeDiscount(tt, money, tp) })}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="align-top font-medium">
                  <span className="flex items-center gap-2">
                    <span
                      className="size-3 rounded-full border"
                      style={{ backgroundColor: c.color }}
                      aria-hidden
                    />
                    {c.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{money(c.basePrice)}</span>
                </TableCell>
                {ticketTypes.map((tt) => {
                  const k = key(c.id, tt.id);
                  const cell = cells[k] ?? initialCell(undefined);
                  const override = cellOverride(cell);
                  const invalid =
                    Boolean(errorOf(state, `value:${k}`)) ||
                    (cell.mode !== 'default' && cell.value !== '' && override === null);
                  const price = computeTicketPrice(c.basePrice, tt, override ?? undefined);
                  return (
                    <TableCell key={tt.id} className="space-y-2 align-top">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name={`offer:${k}`}
                          className="size-4"
                          checked={cell.offered}
                          onChange={(e) => update(k, { offered: e.target.checked })}
                        />
                        {t('offered')}
                      </label>
                      {cell.offered && (
                        <>
                          <div className="flex items-center gap-2">
                            <NativeSelect
                              name={`mode:${k}`}
                              aria-label={t('mode')}
                              value={cell.mode}
                              onChange={(e) => update(k, { mode: e.target.value as CellMode })}
                              className="h-8 min-w-0 flex-1 px-2 text-xs"
                            >
                              {CELL_MODES.map((m) => (
                                <option key={m} value={m}>
                                  {t(`modes.${m}`)}
                                </option>
                              ))}
                            </NativeSelect>
                            {cell.mode !== 'default' && (
                              <div className="relative w-24 shrink-0">
                                <Input
                                  name={`value:${k}`}
                                  inputMode="decimal"
                                  placeholder={cell.mode === 'percent' ? '10' : '5,00'}
                                  aria-label={t(`modes.${cell.mode}`)}
                                  value={cell.value}
                                  onChange={(e) => update(k, { value: e.target.value })}
                                  aria-invalid={invalid}
                                  className="h-8 pr-7 text-right tabular-nums"
                                />
                                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
                                  {cell.mode === 'percent' ? '%' : currencySymbol}
                                </span>
                              </div>
                            )}
                          </div>
                          <p
                            className={
                              invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                            }
                          >
                            {invalid
                              ? t('invalidValue')
                              : t('finalPrice', { price: money(price.priceGross) })}
                          </p>
                        </>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}
