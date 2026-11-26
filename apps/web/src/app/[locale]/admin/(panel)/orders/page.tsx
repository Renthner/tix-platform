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
import { Download, Inbox } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { EmptyState } from '@/components/admin/empty-state';
import { FilterSelect } from '@/components/admin/filter-select';
import {
  ListToolbar,
  MoreFilterField,
  type ActiveFilterChip,
} from '@/components/admin/list-toolbar';
import { AdminPageHeader } from '@/components/admin/page-header';
import { OrdersTable, type SortHeader } from '@/components/admin/orders-table';
import { RememberTestsFilter } from '@/components/admin/orders-tests-cookie';
import { StatusTabs } from '@/components/admin/status-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
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
/** Quick filters of the status tabs (one at a time). */
const QUICK = ['open', 'overdue', 'today'] as const;

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
  const [t, tl, tChannel, tStatus, tMethod, format, locale, result, eventRows] = await Promise.all([
    getTranslations('orders.admin'),
    getTranslations('admin.list'),
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
    // All events (no cap): a native select with type-ahead.
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
  const keptPageSize = pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined;

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
      href: buildQuery(base, listParams, { sort: key, dir: nextDir, pageSize: keptPageSize }),
    };
  }

  // Status tabs: All / Open / Overdue / Today (one at a time; every other filter is kept).
  const noQuick = {
    open: undefined,
    overdue: undefined,
    today: undefined,
    pageSize: keptPageSize,
  };
  const activeQuick = QUICK.find((key) => filters[key] === '1');
  const tabs = [
    {
      key: 'all',
      label: tl('all'),
      href: buildQuery(base, listParams, noQuick),
      active: !activeQuick,
      'data-testid': 'chip-all',
    },
    ...QUICK.map((key) => ({
      key,
      label: t(`chips.${key}`),
      href: buildQuery(base, listParams, { ...noQuick, [key]: '1' }),
      active: activeQuick === key,
      'data-testid': `chip-${key}`,
    })),
  ];

  // Active toolbar filters (removable chips) and the reset link (quick tab and sort stay).
  const eventLabel = (id: string) => {
    const e = eventRows.find((row) => row.id === id);
    return e ? `${e.title} · ${format.dateTime(e.startsAt, { dateStyle: 'short' })}` : id;
  };
  const without = (overrides: Record<string, string | undefined>) =>
    buildQuery(base, listParams, { pageSize: keptPageSize, ...overrides });
  const chips: ActiveFilterChip[] = [];
  if (filters.q) {
    chips.push({
      key: 'q',
      label: tl('searchChip', { value: filters.q }),
      removeHref: without({ q: undefined }),
    });
  }
  if (filters.status) {
    chips.push({
      key: 'status',
      label: `${t('filters.status')}: ${tStatus(filters.status)}`,
      removeHref: without({ status: undefined }),
    });
  }
  if (filters.event) {
    chips.push({
      key: 'event',
      label: `${t('filters.event')}: ${eventLabel(filters.event)}`,
      removeHref: without({ event: undefined }),
    });
  }
  if (filters.method) {
    chips.push({
      key: 'method',
      label: `${t('filters.method')}: ${tMethod(filters.method)}`,
      removeHref: without({ method: undefined }),
    });
  }
  if (filters.channel) {
    chips.push({
      key: 'channel',
      label: `${t('filters.channel')}: ${tChannel(filters.channel)}`,
      removeHref: without({ channel: undefined }),
    });
  }
  if (filters.tests !== 'hide') {
    chips.push({
      key: 'tests',
      label: t(filters.tests === 'only' ? 'filters.testsOnly' : 'filters.testsAll'),
      // Explicit "hide": a super admin's remembered choice (cookie) would come back otherwise.
      removeHref: without({ tests: 'hide' }),
    });
  }
  if (filters.from) {
    chips.push({
      key: 'from',
      label: `${t('filters.from')}: ${filters.from}`,
      removeHref: without({ from: undefined }),
    });
  }
  if (filters.to) {
    chips.push({
      key: 'to',
      label: `${t('filters.to')}: ${filters.to}`,
      removeHref: without({ to: undefined }),
    });
  }
  const resetHref =
    chips.length > 0
      ? buildQuery(base, {
          open: filters.open,
          overdue: filters.overdue,
          today: filters.today,
          tests: filters.tests !== 'hide' ? 'hide' : undefined,
          sort: filters.sort,
          dir: filters.dir,
          pageSize: keptPageSize,
        })
      : null;
  const moreActiveCount = [
    filters.channel,
    filters.tests !== 'hide' ? filters.tests : undefined,
    filters.from,
    filters.to,
    // Counted only on top of another tab (the "Overdue" tab shows it already).
    filters.overdue && activeQuick !== 'overdue' ? filters.overdue : undefined,
  ].filter(Boolean).length;

  const exportHref = buildQuery('/api/admin/orders/export', { ...listParams, locale });
  const dateClass =
    'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm font-normal text-foreground';
  const wideSelect = '[&_select]:max-w-none [&_select]:w-full';

  return (
    <>
      <AdminPageHeader title={t('title')} description={t('description')} />
      <div className="space-y-4 p-6">
        <RememberTestsFilter
          name={ORDERS_TESTS_COOKIE}
          value={isSuperAdmin && sp.tests ? filters.tests : null}
        />
        <StatusTabs label={t('chips.label')} tabs={tabs} />
        <ListToolbar
          data-testid="orders-toolbar"
          search={{ value: filters.q, placeholder: t('searchPlaceholder') }}
          filters={
            <>
              <FilterSelect
                name="status"
                value={filters.status}
                ariaLabel={t('filters.status')}
                allLabel={t('filters.allStatuses')}
                searchable={false}
                options={ORDER_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
              />
              <FilterSelect
                name="event"
                value={filters.event}
                ariaLabel={t('filters.event')}
                allLabel={t('filters.allEvents')}
                searchable={false}
                options={eventRows.map((e) => ({ value: e.id, label: eventLabel(e.id) }))}
              />
              <FilterSelect
                name="method"
                value={filters.method}
                ariaLabel={t('filters.method')}
                allLabel={t('filters.allMethods')}
                searchable={false}
                options={PAYMENT_METHODS.map((m) => ({ value: m, label: tMethod(m) }))}
              />
            </>
          }
          moreActiveCount={moreActiveCount}
          moreFilters={
            <>
              <MoreFilterField label={t('filters.channel')}>
                <FilterSelect
                  name="channel"
                  value={filters.channel}
                  ariaLabel={t('filters.channel')}
                  allLabel={t('filters.allChannels')}
                  searchable={false}
                  className={wideSelect}
                  options={SALES_CHANNELS.map((c) => ({ value: c, label: tChannel(c) }))}
                />
              </MoreFilterField>
              <MoreFilterField label={t('filters.tests')}>
                <FilterSelect
                  name="tests"
                  value={filters.tests}
                  ariaLabel={t('filters.tests')}
                  searchable={false}
                  className={wideSelect}
                  options={[
                    { value: 'hide', label: t('filters.testsHide') },
                    { value: 'all', label: t('filters.testsAll') },
                    { value: 'only', label: t('filters.testsOnly') },
                  ]}
                />
              </MoreFilterField>
              <div className="grid grid-cols-2 gap-2">
                <MoreFilterField label={t('filters.from')}>
                  <input
                    type="date"
                    name="from"
                    defaultValue={filters.from ?? ''}
                    className={dateClass}
                  />
                </MoreFilterField>
                <MoreFilterField label={t('filters.to')}>
                  <input
                    type="date"
                    name="to"
                    defaultValue={filters.to ?? ''}
                    className={dateClass}
                  />
                </MoreFilterField>
              </div>
              {/* Combinable with the "Open" / "Today" tabs; no hidden input, so unchecking clears it. */}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="overdue"
                  value="1"
                  defaultChecked={filters.overdue === '1'}
                />
                {t('filters.overdue')}
              </label>
            </>
          }
          hidden={{
            open: filters.open,
            today: filters.today,
            sort: filters.sort,
            dir: filters.sort ? filters.dir : undefined,
            pageSize: keptPageSize,
          }}
          resetHref={resetHref}
          chips={chips}
          actions={
            <Button asChild variant="outline">
              <a href={exportHref} download data-testid="orders-export">
                <Download /> {t('export')}
              </a>
            </Button>
          }
        />

        <Card>
          <CardContent>
            {result.rows.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={t('empty')}
                description={resetHref || activeQuick ? tl('emptyFiltered') : undefined}
                action={
                  resetHref ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={resetHref}>{tl('reset')}</Link>
                    </Button>
                  ) : undefined
                }
              />
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
