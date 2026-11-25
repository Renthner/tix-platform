import { getCashUpReport, getSetting, listCashUpSellers, type CashUpTotals } from '@tix/core';
import { events } from '@tix/db';
import { buildQuery } from '@tix/shared';
import { desc } from 'drizzle-orm';
import { Download } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { FilterSelect } from '@/components/admin/filter-select';
import { PageHeader } from '@/components/admin/form-controls';
import { PrintButton } from '@/components/admin/print-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { resolveLocale } from '@/i18n/locale';
import { isOwnSalesOnly, parseCashUpFilter } from '@/server/admin/cash-up-filters';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('accounting.cashUp');
  return { title: t('title') };
}

export default async function CashUpPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER', 'DOOR_STAFF']);
  const sp = await searchParams;
  const core = getCore();
  const general = await getSetting(core, 'general');
  const filter = parseCashUpFilter(sp, session, general.defaultTimeZone);
  const ownOnly = isOwnSalesOnly(session);
  const [t, tMethod, format, locale, report, eventRows, sellers] = await Promise.all([
    getTranslations('accounting.cashUp'),
    getTranslations('orders.method'),
    getFormatter(),
    getLocale(),
    getCashUpReport(core, filter),
    core.db
      .select({ id: events.id, title: events.title, startsAt: events.startsAt })
      .from(events)
      .orderBy(desc(events.startsAt)),
    ownOnly ? Promise.resolve([]) : listCashUpSellers(core),
  ]);
  const money = (cents: number, currency: string) =>
    format.number(cents / 100, { style: 'currency', currency });
  const exportHref = buildQuery(
    '/api/admin/cash-up/export',
    {},
    {
      from: filter.from,
      to: filter.to,
      event: filter.eventId,
      seller: ownOnly ? undefined : filter.sellerUserId,
      locale,
    },
  );
  const row = (label: string, totals: CashUpTotals, currency: string, key: string) => (
    <TableRow key={key}>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-right tabular-nums">{totals.orders}</TableCell>
      <TableCell className="text-right tabular-nums">{totals.tickets}</TableCell>
      <TableCell className="text-right tabular-nums">{money(totals.sales, currency)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(totals.gross, currency)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(totals.refunded, currency)}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {money(totals.net, currency)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {totals.refundedOrders}
        {totals.refundsOpen > 0 && (
          <div className="text-xs text-destructive">
            {t('refundsOpen', { amount: money(totals.refundsOpen, currency) })}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{totals.cancelledOrders}</TableCell>
    </TableRow>
  );
  const head = (first: string) => (
    <TableHeader>
      <TableRow>
        <TableHead>{first}</TableHead>
        <TableHead className="text-right">{t('columns.orders')}</TableHead>
        <TableHead className="text-right">{t('columns.tickets')}</TableHead>
        <TableHead className="text-right">{t('columns.gross')}</TableHead>
        <TableHead className="text-right">{t('columns.received')}</TableHead>
        <TableHead className="text-right">{t('columns.refunded')}</TableHead>
        <TableHead className="text-right">{t('columns.net')}</TableHead>
        <TableHead className="text-right">{t('columns.refundedOrders')}</TableHead>
        <TableHead className="text-right">{t('columns.cancelledOrders')}</TableHead>
      </TableRow>
    </TableHeader>
  );
  const sellerName = (name: string | null) => name ?? t('unknownSeller');
  // Amounts of different currencies are never added up; the currency is named only when needed.
  const multiCurrency = new Set(report.lines.map((l) => l.currency)).size > 1;
  const withCurrency = (label: string, currency: string) =>
    multiCurrency ? `${label} (${currency})` : label;

  return (
    <div data-print-view>
      <PageHeader
        title={t('title')}
        description={ownOnly ? t('ownSales') : t('description')}
        actions={
          <div className="flex gap-2" data-print-hide>
            <Button asChild variant="outline">
              <a href={exportHref} download data-testid="cash-up-export">
                <Download /> {t('export')}
              </a>
            </Button>
            <PrintButton label={t('print')} />
          </div>
        }
      />
      <div className="space-y-4 p-6">
        <form className="flex flex-wrap items-end gap-2" action="" method="get" data-print-hide>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.from')}
            <input
              type="date"
              name="from"
              defaultValue={filter.from}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.to')}
            <input
              type="date"
              name="to"
              defaultValue={filter.to}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            />
          </label>
          <FilterSelect
            name="event"
            value={filter.eventId}
            ariaLabel={t('filters.event')}
            allLabel={t('filters.allEvents')}
            searchable
            options={eventRows.map((e) => ({
              value: e.id,
              label: `${e.title} · ${format.dateTime(e.startsAt, { dateStyle: 'short' })}`,
            }))}
          />
          {!ownOnly && (
            <FilterSelect
              name="seller"
              value={filter.sellerUserId}
              ariaLabel={t('filters.seller')}
              allLabel={t('filters.allSellers')}
              options={sellers.map((s) => ({ value: s.id, label: s.name }))}
            />
          )}
          <Button type="submit" variant="secondary">
            {t('filters.apply')}
          </Button>
        </form>

        <p className="text-sm text-muted-foreground">
          {t('range', { from: filter.from, to: filter.to })}
        </p>

        {report.lines.length === 0 ? (
          <Card>
            <CardContent>
              <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>{t('byMethod')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  {head(t('columns.method'))}
                  <TableBody>
                    {report.byMethod.map((m) =>
                      row(
                        withCurrency(tMethod(m.method), m.currency),
                        m.totals,
                        m.currency,
                        `${m.method}-${m.currency}`,
                      ),
                    )}
                  </TableBody>
                  <TableFooter>
                    {report.totals.map((total) =>
                      row(
                        withCurrency(t('total'), total.currency),
                        total.totals,
                        total.currency,
                        `total-${total.currency}`,
                      ),
                    )}
                  </TableFooter>
                </Table>
              </CardContent>
            </Card>
            {!ownOnly && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('bySeller')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    {head(t('columns.seller'))}
                    <TableBody>
                      {report.bySeller.map((s) =>
                        row(
                          withCurrency(sellerName(s.sellerName), s.currency),
                          s.totals,
                          s.currency,
                          `${s.sellerUserId ?? 'none'}-${s.currency}`,
                        ),
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle>{t('detail')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  {head(t('columns.sellerMethod'))}
                  <TableBody>
                    {report.lines.map((l) =>
                      row(
                        withCurrency(
                          `${sellerName(l.sellerName)} · ${tMethod(l.method)}`,
                          l.currency,
                        ),
                        {
                          orders: l.orders,
                          tickets: l.tickets,
                          sales: l.sales,
                          gross: l.gross,
                          refunded: l.refunded,
                          net: l.gross - l.refunded,
                          refundedOrders: l.refundedOrders,
                          refundedOrdersGross: l.refundedOrdersGross,
                          refundsOpen: l.refundsOpen,
                          cancelledOrders: l.cancelledOrders,
                          cancelledGross: l.cancelledGross,
                        },
                        l.currency,
                        `${l.sellerUserId ?? 'none'}-${l.method}-${l.currency}`,
                      ),
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground">{t('note')}</p>
          </>
        )}
      </div>
    </div>
  );
}
