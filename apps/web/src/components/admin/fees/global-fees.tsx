'use client';

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useOptimistic, useTransition } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { FeeActionState } from '@/server/admin/fees';
import { FeeExample } from './fee-example';
import { FeeDialog } from './fee-form';
import { adjustmentSummary, taxRateLabel, useFeeFormat } from './format';
import { TaxRatesSection } from './tax-rates';
import type { Action, GlobalFeeRowView, TaxRateRowView } from './types';
import { FeeConfirm, Section, TriggerButton, useDirectFeedback } from './ui';

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
