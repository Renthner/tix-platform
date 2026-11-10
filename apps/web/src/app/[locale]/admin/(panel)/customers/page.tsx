import { getSetting, listCustomers } from '@tix/core';
import { Search } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
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

const PAGE_SIZE = 50;

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
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const q = sp.q?.slice(0, 100);
  const core = getCore();
  const [t, format, result, privacy, general] = await Promise.all([
    getTranslations('customers'),
    getFormatter(),
    listCustomers(core, { q, page, pageSize: PAGE_SIZE }),
    getSetting(core, 'privacy'),
    getSetting(core, 'general'),
  ]);
  const currency = general.defaultCurrency;
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const href = (p: number) => {
    const usp = new URLSearchParams();
    if (q) usp.set('q', q);
    if (p > 1) usp.set('page', String(p));
    const s = usp.toString();
    return s ? `/admin/customers?${s}` : '/admin/customers';
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
          <Button type="submit">{t('search')}</Button>
        </form>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.name')}</TableHead>
                  <TableHead>{t('columns.email')}</TableHead>
                  <TableHead>{t('columns.phone')}</TableHead>
                  <TableHead>{t('columns.account')}</TableHead>
                  <TableHead className="text-right">{t('columns.orders')}</TableHead>
                  <TableHead className="text-right">{t('columns.revenue')}</TableHead>
                  <TableHead>{t('columns.lastOrder')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('total', { count: result.total })}</span>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              {page > 1 && (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(page - 1)}>{t('prev')}</Link>
                </Button>
              )}
              <span>{t('pageOf', { page, pages })}</span>
              {page < pages && (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(page + 1)}>{t('next')}</Link>
                </Button>
              )}
            </div>
          )}
        </div>
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
