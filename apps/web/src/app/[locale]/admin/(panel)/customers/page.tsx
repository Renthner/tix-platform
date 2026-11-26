import { CUSTOMER_SORT_KEYS, getSetting, listCustomers, type CustomerSortKey } from '@tix/core';
import { buildQuery, parsePage, parsePageSize } from '@tix/shared';
import { ArrowDown, ArrowUp, UserRound } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { EmptyState } from '@/components/admin/empty-state';
import { ListToolbar, type ActiveFilterChip } from '@/components/admin/list-toolbar';
import { AdminPageHeader } from '@/components/admin/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('customers');
  return { title: t('title') };
}

const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const pageSize = parsePageSize(sp.pageSize, PAGE_SIZES, DEFAULT_PAGE_SIZE);
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const sort = (CUSTOMER_SORT_KEYS as readonly string[]).includes(sp.sort ?? '')
    ? (sp.sort as CustomerSortKey)
    : undefined;
  const dir = sp.dir === 'asc' ? 'asc' : sp.dir === 'desc' ? 'desc' : undefined;
  const core = getCore();
  const [t, tl, format, result, general] = await Promise.all([
    getTranslations('customers'),
    getTranslations('admin.list'),
    getFormatter(),
    listCustomers(core, {
      q,
      page,
      pageSize,
      sort,
      dir: dir ?? (sort === 'name' ? 'asc' : 'desc'),
    }),
    getSetting(core, 'general'),
  ]);
  const currency = general.defaultCurrency;
  const keptPageSize = pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined;
  const filters = { q, sort, dir, pageSize: keptPageSize };
  // Click a sortable header: first click = natural direction, second click flips it.
  const sortHref = (key: CustomerSortKey) => {
    const natural = key === 'name' ? 'asc' : 'desc';
    const active = sort === key;
    const current = dir ?? natural;
    const next = active ? (current === 'asc' ? 'desc' : 'asc') : natural;
    return buildQuery('/admin/customers', filters, { sort: key, dir: next, page: undefined });
  };
  const sortHead = (k: CustomerSortKey, className?: string) => {
    const active = sort === k;
    const current = dir ?? (k === 'name' ? 'asc' : 'desc');
    return (
      <TableHead
        key={k}
        className={className}
        aria-sort={active ? (current === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <Link href={sortHref(k)} className="inline-flex items-center gap-1 hover:underline">
          {t(`columns.${k}`)}
          {active &&
            (current === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
        </Link>
      </TableHead>
    );
  };

  // The search is the only filter; sort and page size stay when it is removed.
  const resetHref = q ? buildQuery('/admin/customers', filters, { q: undefined }) : null;
  const chips: ActiveFilterChip[] =
    q && resetHref
      ? [{ key: 'q', label: tl('searchChip', { value: q }), removeHref: resetHref }]
      : [];

  return (
    <>
      <AdminPageHeader title={t('title')} description={t('description')} />
      <div className="space-y-4 p-6">
        <ListToolbar
          data-testid="customers-toolbar"
          search={{ value: q, placeholder: t('searchPlaceholder') }}
          hidden={{ sort, dir, pageSize: keptPageSize }}
          resetHref={resetHref}
          chips={chips}
        />
        <Card>
          <CardContent className={result.rows.length === 0 ? undefined : 'p-0'}>
            {result.rows.length === 0 ? (
              <EmptyState
                icon={UserRound}
                title={t('empty')}
                description={q ? tl('emptyFiltered') : undefined}
                action={
                  resetHref ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={resetHref}>{tl('reset')}</Link>
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {sortHead('name')}
                    <TableHead>{t('columns.email')}</TableHead>
                    <TableHead>{t('columns.phone')}</TableHead>
                    <TableHead>{t('columns.account')}</TableHead>
                    {sortHead('orders', 'text-right')}
                    <TableHead className="text-right">{t('columns.revenue')}</TableHead>
                    {sortHead('lastOrder')}
                    {sortHead('created')}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        <Link href={`/admin/customers/${row.id}`} className="hover:underline">
                          {row.anonymizedAt ? (
                            <span className="text-muted-foreground">{t('anonymizedName')}</span>
                          ) : (
                            `${row.firstName} ${row.lastName}`
                          )}
                        </Link>{' '}
                        {row.anonymizedAt && <Badge variant="secondary">{t('anonymized')}</Badge>}
                      </TableCell>
                      <TableCell>{row.anonymizedAt ? '–' : row.email}</TableCell>
                      <TableCell className="whitespace-nowrap">{row.phone ?? '–'}</TableCell>
                      <TableCell>
                        {row.hasAccount ? (
                          <Badge variant={row.emailVerified ? 'default' : 'outline'}>
                            {row.emailVerified ? t('account.verified') : t('account.unverified')}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">{t('account.guest')}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.orderCount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {format.number(row.revenue / 100, { style: 'currency', currency })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {row.lastOrderAt
                          ? format.dateTime(row.lastOrderAt, { dateStyle: 'medium' })
                          : '–'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {format.dateTime(row.createdAt, { dateStyle: 'medium' })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <AdminPagination
          pathname="/admin/customers"
          params={{ q, sort, dir }}
          page={page}
          pageSize={pageSize}
          defaultPageSize={DEFAULT_PAGE_SIZE}
          pageSizes={PAGE_SIZES}
          total={result.total}
          summary={t('total', { count: result.total })}
        />
        {hasRole(session, ['SUPER_ADMIN']) && (
          <p className="text-sm text-muted-foreground" data-testid="customers-retention-hint">
            {t.rich('settings.movedHint', {
              link: (chunks) => (
                <Link href="/admin/settings/privacy" className="font-medium underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}
      </div>
    </>
  );
}
