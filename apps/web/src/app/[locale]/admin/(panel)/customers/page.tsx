import { CUSTOMER_SORT_KEYS, getSetting, listCustomers, type CustomerSortKey } from '@tix/core';
import { buildQuery, parsePage, parsePageSize } from '@tix/shared';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { PageHeader } from '@/components/admin/form-controls';
import { PrivacySettingsForm } from '@/components/admin/customers/customer-forms';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  const [t, format, result, privacy, general] = await Promise.all([
    getTranslations('customers'),
    getFormatter(),
    listCustomers(core, {
      q,
      page,
      pageSize,
      sort,
      dir: dir ?? (sort === 'name' ? 'asc' : 'desc'),
    }),
    getSetting(core, 'privacy'),
    getSetting(core, 'general'),
  ]);
  const currency = general.defaultCurrency;
  const filters = { q, sort, dir, pageSize: pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined };
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

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-4 p-6">
        <form className="flex gap-2" action="" method="get">
          <div className="relative min-w-64 flex-1">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              name="q"
              defaultValue={q ?? ''}
              placeholder={t('searchPlaceholder')}
              className="pl-8"
            />
          </div>
          {sort && <input type="hidden" name="sort" value={sort} />}
          {dir && <input type="hidden" name="dir" value={dir} />}
          {pageSize !== DEFAULT_PAGE_SIZE && (
            <input type="hidden" name="pageSize" value={pageSize} />
          )}
          <Button type="submit">{t('search')}</Button>
        </form>
        <Card>
          <CardContent className="p-0">
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
                {result.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      {t('empty')}
                    </TableCell>
                  </TableRow>
                )}
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
                    <TableCell>{row.phone ?? '–'}</TableCell>
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
                    <TableCell>
                      {row.lastOrderAt
                        ? format.dateTime(row.lastOrderAt, { dateStyle: 'medium' })
                        : '–'}
                    </TableCell>
                    <TableCell>{format.dateTime(row.createdAt, { dateStyle: 'medium' })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.title')}</CardTitle>
              <CardDescription>{t('settings.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <PrivacySettingsForm initial={privacy} />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
