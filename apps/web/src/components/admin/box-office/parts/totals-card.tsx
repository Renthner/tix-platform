'use client';

import { Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMoney } from '@/lib/format';
import { Row } from './primitives';
import type { Payment, Quote } from './types';

export function TotalsCard({
  quote,
  quoteError,
  quoteBusy,
  payment,
  given,
  setGiven,
  givenCents,
  lineCount,
  ticketCount,
  selling,
  sellDisabled,
  onClear,
  onSell,
}: {
  quote: Quote | null;
  quoteError: string | null;
  quoteBusy: boolean;
  payment: Payment;
  given: string;
  setGiven: (value: string) => void;
  givenCents: number | null;
  lineCount: number;
  ticketCount: number;
  selling: boolean;
  /** Everything except `selling`/`lineCount` that blocks the sell button. */
  sellDisabled: boolean;
  onClear: () => void;
  onSell: () => void;
}) {
  const t = useTranslations('orders.boxOffice');
  const tMethod = useTranslations('orders.method');
  const money = useMoney();
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        {quoteError && <p className="text-sm text-destructive">{quoteError}</p>}
        {quote && (
          <dl className="space-y-1 text-sm">
            <Row label={t('totals.subtotal')} value={money(quote.subtotalGross, quote.currency)} />
            {quote.discountTotal > 0 && (
              <Row
                label={t('totals.discount')}
                value={`−${money(quote.discountTotal, quote.currency)}`}
              />
            )}
            {quote.fees.map((fee, i) => (
              <Row key={i} label={fee.name} value={money(fee.totalGross, quote.currency)} />
            ))}
            <div className="flex justify-between border-t pt-1 text-base font-semibold">
              <dt>{t('totals.total')}</dt>
              <dd className="tabular-nums">{money(quote.totalGross, quote.currency)}</dd>
            </div>
          </dl>
        )}
        {!quote && !quoteError && quoteBusy && (
          <p className="text-sm text-muted-foreground">{t('totals.calculating')}</p>
        )}
        {payment === 'CASH' && quote && quote.totalGross > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="bo-given">{t('cash.given')}</Label>
            <Input
              id="bo-given"
              inputMode="decimal"
              value={given}
              onChange={(e) => setGiven(e.target.value)}
            />
            {givenCents !== null && (
              <p
                className={`text-sm font-medium tabular-nums ${givenCents < quote.totalGross ? 'text-destructive' : ''}`}
              >
                {givenCents >= quote.totalGross
                  ? `${t('cash.change')}: ${money(givenCents - quote.totalGross, quote.currency)}`
                  : `${t('cash.missing')}: ${money(quote.totalGross - givenCents, quote.currency)}`}
              </p>
            )}
          </div>
        )}
        {lineCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={selling}
            onClick={onClear}
          >
            <X /> {t('clearSelection')}
          </Button>
        )}
        <Button
          className="w-full"
          size="lg"
          disabled={selling || lineCount === 0 || sellDisabled}
          onClick={onSell}
        >
          {selling ? (
            <>
              <Loader2 className="animate-spin" /> {t('selling')}
            </>
          ) : (
            <>
              {t('sellCount', { count: ticketCount })} · {tMethod(payment)}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
