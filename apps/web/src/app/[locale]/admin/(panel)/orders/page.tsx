import { searchOrders } from '@tix/core';
import { events } from '@tix/db';
import { ORDER_STATUSES, PAYMENT_METHODS, type OrderStatus, type PaymentMethod } from '@tix/shared';
import { desc } from 'drizzle-orm';
import { Search } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { OrderStatusBadge } from '@/components/admin/order-badges';
import { PageHeader } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('orders.admin');
  return { title: t('title') };
}

const PAGE_SIZE = 50;

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  const sp = await searchParams;
  const status = (ORDER_STATUSES as readonly string[]).includes(sp.status ?? '')
    ? (sp.status as OrderStatus)
    : undefined;
  const method = (PAYMENT_METHODS as readonly string[]).includes(sp.method ?? '')
    ? (sp.method as PaymentMethod)
    : undefined;
  const eventId = /^[0-9a-f-]{36}$/i.test(sp.event ?? '') ? sp.event : undefined;
  const overdueOnly = sp.overdue === '1';
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const q = sp.q?.slice(0, 100);
  const core = getCore();
  const [t, tStatus, tMethod, format, result, eventRows] = await Promise.all([
    getTranslations('orders.admin'),
    getTranslations('orders.status'),
    getTranslations('orders.method'),
    getFormatter(),
    searchOrders(core, { q, status, method, eventId, overdueOnly, page, pageSize: PAGE_SIZE }),
    core.db
      .select({ id: events.id, title: events.title, startsAt: events.startsAt })
      .from(events)
      .orderBy(desc(events.startsAt))
      .limit(200),
  ]);
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const query = (overrides: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = {
      q,
      status,
      method,
      event: eventId,
      overdue: overdueOnly ? '1' : undefined,
      ...overrides,
    };
    const usp = new URLSearchParams(
      Object.entries(merged).filter((e): e is [string, string] => Boolean(e[1])),
    );
    const s = usp.toString();
    return s ? `/admin/orders?${s}` : '/admin/orders';
  };

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-4 p-6">
        <form className="flex flex-wrap items-end gap-2" action="" method="get">
          <div className="relative min-w-64 flex-1">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              name="q"
              defaultValue={q ?? ''}
              placeholder={t('searchPlaceholder')}
              className="pl-8"
            />
          </div>
          <select
            name="status"
            defaultValue={status ?? ''}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            aria-label={t('filters.status')}
          >
            <option value="">{t('filters.allStatuses')}</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {tStatus(s)}
              </option>
            ))}
          </select>
          <select
            name="method"
            defaultValue={method ?? ''}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            aria-label={t('filters.method')}
          >
            <option value="">{t('filters.allMethods')}</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {tMethod(m)}
              </option>
            ))}
          </select>
          <select
            name="event"
            defaultValue={eventId ?? ''}
            className="h-9 max-w-64 rounded-md border border-input bg-transparent px-3 text-sm"
            aria-label={t('filters.event')}
          >
            <option value="">{t('filters.allEvents')}</option>
            {eventRows.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title} · {format.dateTime(e.startsAt, { dateStyle: 'short' })}
              </option>
            ))}
          </select>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" name="overdue" value="1" defaultChecked={overdueOnly} />
            {t('filters.overdue')}
          </label>
          <Button type="submit" variant="secondary">
            {t('filters.apply')}
          </Button>
        </form>

        <Card>
          <CardContent>
            {result.rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.number')}</TableHead>
                    <TableHead>{t('columns.date')}</TableHead>
                    <TableHead>{t('columns.customer')}</TableHead>
                    <TableHead>{t('columns.method')}</TableHead>
                    <TableHead className="text-right">{t('columns.tickets')}</TableHead>
                    <TableHead className="text-right">{t('columns.total')}</TableHead>
                    <TableHead>{t('columns.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium whitespace-nowrap">
                        <Link href={`/admin/orders/${row.id}`} className="hover:underline">
                          {row.orderNumber}
                        </Link>
                        {row.paymentReference && (
                          <div className="font-mono text-xs text-muted-foreground">
                            {row.paymentReference}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {format.dateTime(row.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                      </TableCell>
                      <TableCell>
                        <div>
                          {row.firstName} {row.lastName}
                        </div>
                        <div className="text-xs text-muted-foreground">{row.email}</div>
                      </TableCell>
                      <TableCell>{tMethod(row.paymentMethod)}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.ticketCount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {format.number(row.totalGross / 100, {
                          style: 'currency',
                          currency: row.currency,
                        })}
                      </TableCell>
                      <TableCell>
                        <OrderStatusBadge status={row.status} />
                        {row.keepReserved && (
                          <div className="text-xs text-muted-foreground">{t('keptReserved')}</div>
                        )}
                        {row.status === 'AWAITING_PAYMENT' &&
                          row.paymentDueAt &&
                          row.paymentDueAt.getTime() < Date.now() && (
                            <div className="text-xs text-destructive">{t('overdue')}</div>
                          )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('total', { count: result.total })}</span>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              {page > 1 && (
                <Button asChild variant="outline" size="sm">
                  <Link href={query({ page: String(page - 1) })}>{t('previous')}</Link>
                </Button>
              )}
              <span>{t('page', { page, pages })}</span>
              {page < pages && (
                <Button asChild variant="outline" size="sm">
                  <Link href={query({ page: String(page + 1) })}>{t('next')}</Link>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
