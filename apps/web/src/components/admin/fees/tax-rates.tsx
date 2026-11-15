'use client';

import { formatHundredths } from '@tix/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
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
import { ActionForm, Field, SubmitButton, errorOf } from '../form-controls';
import { useFeeFormat } from './format';
import type { Action, TaxRateRowView } from './types';
import { FeeConfirm, FeeFeedback, Section, TriggerButton, useDialogAction } from './ui';

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

export function TaxRatesSection({
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
