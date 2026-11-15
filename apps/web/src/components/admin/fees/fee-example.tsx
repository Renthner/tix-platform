'use client';

import {
  exampleFeeAmount,
  formatHundredths,
  parseFeeAmountToCents,
  type PaymentMethod,
} from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Field } from '../form-controls';
import { useFeeFormat } from './format';
import type { FeeView } from './types';
import { Section } from './ui';

/** Payment methods of the online checkout (used for the example). */
const ONLINE_METHODS = ['PAYPAL', 'BANK_TRANSFER'] as const satisfies readonly PaymentMethod[];

// ─── Example ────────────────────────────────────────────────────────────────

/**
 * Live preview of an online order for one event: fees per online payment method, computed
 * like the checkout (event fees in their order, then the order fees).
 */
export function FeeExample({
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
