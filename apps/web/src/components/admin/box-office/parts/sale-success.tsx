'use client';

import { Check, Loader2, Printer } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { useMoney } from '@/lib/format';
import type { SaleResult } from './types';

export function SaleSuccess({
  sale,
  invoiceId,
  invoiceGaveUp,
  canOpenOrders,
  onNext,
}: {
  sale: SaleResult;
  invoiceId: string | null;
  invoiceGaveUp: boolean;
  canOpenOrders: boolean;
  onNext: () => void;
}) {
  const t = useTranslations('orders.boxOffice.success');
  const money = useMoney();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-success">
          <Check className="size-5" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm">
          <div className="font-medium">{t('order', { number: sale.orderNumber })}</div>
          <div>
            {t('total', { amount: money(sale.totalGross, sale.currency) })} ·{' '}
            {t('tickets', { count: sale.ticketCount })}
          </div>
          {sale.email && (
            <div className="text-muted-foreground">{t('emailQueued', { email: sale.email })}</div>
          )}
        </div>
        {!sale.ticketsReady && <p className="text-sm text-warning">{t('ticketsNotReady')}</p>}
        <Button asChild className="w-full" size="lg">
          <a
            href={`/api/admin/box-office/orders/${sale.orderId}/tickets`}
            target="_blank"
            rel="noopener"
          >
            <Printer /> {t('print')}
          </a>
        </Button>
        {sale.payment !== 'COMPLIMENTARY' &&
          (invoiceId ? (
            <Button asChild variant="outline" className="w-full">
              <a
                href={`/api/admin/box-office/orders/${sale.orderId}/invoice`}
                target="_blank"
                rel="noopener"
              >
                {t('invoice')}
              </a>
            </Button>
          ) : (
            !invoiceGaveUp && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t('invoicePending')}
              </p>
            )
          ))}
        <Button variant="secondary" className="w-full" onClick={onNext}>
          {t('nextSale')}
        </Button>
        {canOpenOrders && (
          <Link
            href={`/admin/orders/${sale.orderId}`}
            className="block text-center text-sm text-primary hover:underline"
          >
            {t('orderDetail')}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
