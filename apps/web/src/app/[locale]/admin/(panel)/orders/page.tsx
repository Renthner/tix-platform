import { getSetting, searchOrders } from '@tix/core';
import { events } from '@tix/db';
import {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  SALES_CHANNELS,
  buildQuery,
  parsePage,
  parsePageSize,
} from '@tix/shared';
import { desc } from 'drizzle-orm';
import { Download, Search } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { FilterSelect } from '@/components/admin/filter-select';
import { PageHeader } from '@/components/admin/form-controls';
import { OrdersTable, type SortHeader } from '@/components/admin/orders-table';
import { RememberTestsFilter } from '@/components/admin/orders-tests-cookie';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import {
  ORDERS_TESTS_COOKIE,
  parseOrderFilters,
  toOrderSearch,
} from '@/server/admin/order-filters';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('orders.admin');
  return { title: t('title') };
}

const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;
const SORTABLE = ['number', 'date', 'customer', 'method', 'tickets', 'total', 'status'] as const;

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  const sp = await searchParams;
  const isSuperAdmin = session.roles.includes('SUPER_ADMIN');
  const cookieStore = await cookies();
  const filters = parseOrderFilters(sp, {
    isSuperAdmin,
    cookieTests: cookieStore.get(ORDERS_TESTS_COOKIE)?.value,
  });
  const page = parsePage(sp.page);
  const pageSize = parsePageSize(sp.pageSize, PAGE_SIZES, DEFAULT_PAGE_SIZE);
  const core = getCore();
  const general = await getSetting(core, 'general');
  const [t, tChannel, tStatus, tMethod, format, locale, result, eventRows] = await Promise.all([
    getTranslations('orders.admin'),
    getTranslations('orders.channel'),
    getTranslations('orders.status'),
    getTranslations('orders.method'),
    getFormatter(),
    getLocale(),
    searchOrders(core, {
      ...toOrderSearch(filters, general.defaultTimeZone),
      page,
      pageSize,
    }),
    // All events (no cap): the select narrows the options with its search box.
    core.db
      .select({ id: events.id, title: events.title, startsAt: events.startsAt })
      .from(events)
      .orderBy(desc(events.startsAt)),
  ]);

  const base = '/admin/orders';
  const listParams = {
    q: filters.q,
    status: filters.status,
    method: filters.method,
    channel: filters.channel,
    event: filters.event,
    overdue: filters.overdue,
    open: filters.open,
    today: filters.today,
    from: filters.from,
    to: filters.to,
    // Default ("hide") stays out of the URL.
    tests: sp.tests ? filters.tests : undefined,
    sort: filters.sort,
    dir: filters.dir,
  };

  // Sorting: first click = natural direction, then toggles; the date column defaults to "desc".
  const sortHeaders: Record<string, SortHeader> = {};
  for (const key of SORTABLE) {
    const current = filters.sort ?? 'date';
    const currentDir = filters.sort ? (filters.dir ?? 'desc') : 'desc';
    const active = current === key ? currentDir : null;
    const nextDir =
      active === 'asc' ? 'desc' : active === 'desc' ? 'asc' : key === 'date' ? 'desc' : 'asc';
    sortHeaders[key] = {
      active,
      href: buildQuery(base, listParams, {
        sort: key,
        dir: nextDir,
        pageSize: pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined,
      }),
    };
  }

  const chip = (key: 'open' | 'overdue' | 'today', label: string) => {
    const on = filters[key] === '1';
    return (
      <Link
        key={key}
        href={buildQuery(base, listParams, { [key]: on ? undefined : '1' })}
        aria-pressed={on}
        data-testid={`chip-${key}`}
        className={cn(
          'rounded-full border px-3 py-1 text-sm',
          on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
        )}
      >
        {label}
      </Link>
    );
  };

  const exportHref = buildQuery('/api/admin/orders/export', { ...listParams, locale });
  const selectClass = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild variant="outline">
            <a href={exportHref} download data-testid="orders-export">
              <Download /> {t('export')}
            </a>
          </Button>
        }
      />
      <div className="space-y-4 p-6">
        <RememberTestsFilter
          name={ORDERS_TESTS_COOKIE}
          value={isSuperAdmin && sp.tests ? filters.tests : null}
        />
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('chips.label')}>
          {chip('open', t('chips.open'))}
          {chip('overdue', t('chips.overdue'))}
          {chip('today', t('chips.today'))}
        </div>
        <form className="flex flex-wrap items-end gap-2" action="" method="get">
          <div className="relative min-w-64 flex-1">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              name="q"
              defaultValue={filters.q ?? ''}
              placeholder={t('searchPlaceholder')}
              className="pl-8"
            />
          </div>
          <FilterSelect
            name="status"
            value={filters.status}
            ariaLabel={t('filters.status')}
            allLabel={t('filters.allStatuses')}
            options={ORDER_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
          />
          <FilterSelect
            name="method"
            value={filters.method}
            ariaLabel={t('filters.method')}
            allLabel={t('filters.allMethods')}
            options={PAYMENT_METHODS.map((m) => ({ value: m, label: tMethod(m) }))}
          />
          <FilterSelect
            name="channel"
            value={filters.channel}
            ariaLabel={t('filters.channel')}
            allLabel={t('filters.allChannels')}
            options={SALES_CHANNELS.map((c) => ({ value: c, label: tChannel(c) }))}
          />
          <FilterSelect
            name="event"
            value={filters.event}
            ariaLabel={t('filters.event')}
            allLabel={t('filters.allEvents')}
            searchable
            options={eventRows.map((e) => ({
              value: e.id,
              label: `${e.title} · ${format.dateTime(e.startsAt, { dateStyle: 'short' })}`,
            }))}
          />
          <FilterSelect
            name="tests"
            value={filters.tests}
            ariaLabel={t('filters.tests')}
            options={[
              { value: 'hide', label: t('filters.testsHide') },
              { value: 'all', label: t('filters.testsAll') },
              { value: 'only', label: t('filters.testsOnly') },
            ]}
          />
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.from')}
            <input
              type="date"
              name="from"
              defaultValue={filters.from ?? ''}
              className={selectClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filters.to')}
            <input type="date" name="to" defaultValue={filters.to ?? ''} className={selectClass} />
          </label>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="overdue"
              value="1"
              defaultChecked={filters.overdue === '1'}
            />
            {t('filters.overdue')}
          </label>
          {filters.open && <input type="hidden" name="open" value="1" />}
          {filters.today && <input type="hidden" name="today" value="1" />}
          {filters.sort && <input type="hidden" name="sort" value={filters.sort} />}
          {filters.sort && filters.dir && <input type="hidden" name="dir" value={filters.dir} />}
          {pageSize !== DEFAULT_PAGE_SIZE && (
            <input type="hidden" name="pageSize" value={pageSize} />
          )}
          <Button type="submit" variant="secondary">
            {t('filters.apply')}
          </Button>
        </form>

        <Card>
          <CardContent>
            {result.rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <OrdersTable rows={result.rows} sortHeaders={sortHeaders} now={Date.now()} />
            )}
          </CardContent>
        </Card>
        <AdminPagination
          pathname={base}
          params={listParams}
          page={page}
          pageSize={pageSize}
          defaultPageSize={DEFAULT_PAGE_SIZE}
          pageSizes={PAGE_SIZES}
          total={result.total}
          summary={t('total', { count: result.total })}
        />
      </div>
    </>
  );
}
