'use client';

import { useTranslations } from 'next-intl';
import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { useFieldErrors } from '@/lib/field-errors';
import { useMoney } from '@/lib/format';
import { BuyerForm } from './buyer-form';
import type { BuyerState, Payment, Permissions, Quote } from './types';

export function PaymentCard({
  permissions,
  payment,
  setPayment,
  quote,
  showBuyer,
  setShowBuyer,
  buyerDataMissing,
  buyer,
  setBuyer,
  buyerLocale,
  setBuyerLocale,
  sendEmail,
  setSendEmail,
  emailGiven,
  fe,
}: {
  permissions: Permissions;
  payment: Payment;
  setPayment: (payment: Payment) => void;
  quote: Quote | null;
  showBuyer: boolean;
  setShowBuyer: Dispatch<SetStateAction<boolean>>;
  buyerDataMissing: boolean;
  buyer: BuyerState;
  setBuyer: Dispatch<SetStateAction<BuyerState>>;
  buyerLocale: string;
  setBuyerLocale: (locale: string) => void;
  sendEmail: boolean;
  setSendEmail: (value: boolean) => void;
  emailGiven: boolean;
  fe: ReturnType<typeof useFieldErrors>;
}) {
  const t = useTranslations('orders.boxOffice');
  const money = useMoney();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('payment.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          {(['CASH', 'CARD', 'COMPLIMENTARY'] as const)
            .filter((p) => p !== 'COMPLIMENTARY' || permissions.complimentary)
            .map((p) => (
              <Button
                key={p}
                type="button"
                variant={payment === p ? 'default' : 'outline'}
                aria-pressed={payment === p}
                onClick={() => setPayment(p)}
              >
                {t(`payment.${p}`)}
              </Button>
            ))}
        </div>
        {payment === 'COMPLIMENTARY' && (
          <p className="text-xs text-muted-foreground">{t('complimentaryHint')}</p>
        )}

        {quote?.buyerDataRequired && (
          <p className="text-sm text-warning">
            {t('buyer.required', {
              limit: money(quote.smallAmountInvoiceLimit, quote.currency),
            })}
          </p>
        )}
        <button
          type="button"
          className="text-sm text-primary underline-offset-2 hover:underline"
          onClick={() => setShowBuyer((v) => !v)}
        >
          {showBuyer || buyerDataMissing ? t('buyer.hide') : t('buyer.show')}
        </button>
        {(showBuyer || buyerDataMissing) && (
          <BuyerForm
            buyer={buyer}
            setBuyer={setBuyer}
            buyerLocale={buyerLocale}
            setBuyerLocale={setBuyerLocale}
            fe={fe}
          />
        )}
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={sendEmail && emailGiven}
            disabled={!emailGiven}
            onCheckedChange={(v) => setSendEmail(v === true)}
            className="mt-0.5"
          />
          <span>
            {t('sendEmail')}
            {!emailGiven && (
              <span className="block text-xs text-muted-foreground">
                {t('sendEmailNeedsAddress')}
              </span>
            )}
          </span>
        </label>
      </CardContent>
    </Card>
  );
}
