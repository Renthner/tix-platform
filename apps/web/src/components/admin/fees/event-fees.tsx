'use client';

import { Ban, Pencil, Plus, RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { FeeExample } from './fee-example';
import { FeeDialog } from './fee-form';
import { taxRateLabel, useFeeFormat } from './format';
import type { Action, EventGlobalFeeView, EventOwnFeeView, FeeView, TaxRateOption } from './types';
import { FeeConfirm, Section, TriggerButton } from './ui';

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
            <Link href="/admin/settings/fees">{t('event.manageGlobal')}</Link>
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
