import {
  listAuditActors,
  listAuditFilterOptions,
  listAuditLogs,
  redactAuditValue,
} from '@tix/core';
import { buildQuery, parsePage, parsePageSize } from '@tix/shared';
import { Search } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { FilterSelect } from '@/components/admin/filter-select';
import { PageHeader } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
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
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { parseAuditFilter } from '@/server/audit-filter';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('audit');
  return { title: t('title') };
}

const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const locale = await resolveLocale(params);
  await requireAdmin(['SUPER_ADMIN']);
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const pageSize = parsePageSize(sp.pageSize, PAGE_SIZES, DEFAULT_PAGE_SIZE);
  const filter = parseAuditFilter(sp);
  const core = getCore();
  const [t, format, result, options, actors] = await Promise.all([
    getTranslations('audit'),
    getFormatter(),
    listAuditLogs(core, filter, { page, pageSize }),
    listAuditFilterOptions(core),
    listAuditActors(core),
  ]);
  const queryParams = {
    q: filter.q,
    action: filter.actionPrefix,
    entityType: filter.entityType,
    actor: filter.actorUserId,
    from: sp.from && DAY.test(sp.from) ? sp.from : undefined,
    to: sp.to && DAY.test(sp.to) ? sp.to : undefined,
  };
  const exportHref = buildQuery('/api/admin/audit/export', queryParams, { locale });
  const hasDetail = (v: unknown) =>
    v != null && !(typeof v === 'object' && Object.keys(v as object).length === 0);

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-4 p-4 sm:p-6">
        <form className="flex flex-wrap items-end gap-2" action="" method="get">
          <div className="relative min-w-64 flex-1">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              name="q"
              defaultValue={filter.q ?? ''}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className="pl-8"
            />
          </div>
          <FilterSelect
            name="action"
            value={filter.actionPrefix}
            ariaLabel={t('filters.action')}
            allLabel={t('filters.anyAction')}
            options={options.actionPrefixes.map((p) => ({ value: `${p}.`, label: `${p}.*` }))}
          />
          <FilterSelect
            name="entityType"
            value={filter.entityType}
            ariaLabel={t('filters.entityType')}
            allLabel={t('filters.anyEntity')}
            options={options.entityTypes.map((e) => ({ value: e, label: e }))}
          />
          <FilterSelect
            name="actor"
            value={filter.actorUserId}
            ariaLabel={t('filters.actor')}
            allLabel={t('filters.anyActor')}
            options={actors.map((x) => ({ value: x.id, label: x.label }))}
          />
          <label className="flex items-center gap-1 text-sm text-muted-foreground">
            {t('filters.from')}
            <Input type="date" name="from" defaultValue={queryParams.from ?? ''} className="w-40" />
          </label>
          <label className="flex items-center gap-1 text-sm text-muted-foreground">
            {t('filters.to')}
            <Input type="date" name="to" defaultValue={queryParams.to ?? ''} className="w-40" />
          </label>
          {pageSize !== DEFAULT_PAGE_SIZE && (
            <input type="hidden" name="pageSize" value={pageSize} />
          )}
          <Button type="submit">{t('search')}</Button>
          <Button asChild variant="outline">
            <a href={exportHref}>{t('export')}</a>
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t('exportHint')}</p>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.time')}</TableHead>
                  <TableHead>{t('columns.actor')}</TableHead>
                  <TableHead>{t('columns.action')}</TableHead>
                  <TableHead>{t('columns.entity')}</TableHead>
                  <TableHead>{t('columns.ip')}</TableHead>
                  <TableHead>{t('columns.details')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      {t('empty')}
                    </TableCell>
                  </TableRow>
                )}
                {result.rows.map((row) => (
                  <TableRow key={row.id} className="align-top">
                    <TableCell className="whitespace-nowrap">
                      {format.dateTime(row.createdAt, { dateStyle: 'medium', timeStyle: 'medium' })}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.actorType}</Badge>{' '}
                      {row.actorEmail ?? row.actorName ?? (row.actorDeviceId ? t('device') : '')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.action}</TableCell>
                    <TableCell className="text-xs">
                      {row.entityType}
                      {row.entityId && (
                        <div className="font-mono break-all text-muted-foreground">
                          {row.entityId}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.ipAddress ?? '–'}</TableCell>
                    <TableCell className="max-w-md">
                      {hasDetail(row.changes) || hasDetail(row.metadata) ? (
                        <details>
                          <summary className="cursor-pointer text-sm hover:underline">
                            {t('show')}
                          </summary>
                          {hasDetail(row.changes) && (
                            <>
                              <div className="mt-2 text-xs font-medium">{t('changes')}</div>
                              <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">
                                {JSON.stringify(redactAuditValue(row.changes), null, 2)}
                              </pre>
                            </>
                          )}
                          {hasDetail(row.metadata) && (
                            <>
                              <div className="mt-2 text-xs font-medium">{t('metadata')}</div>
                              <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">
                                {JSON.stringify(redactAuditValue(row.metadata), null, 2)}
                              </pre>
                            </>
                          )}
                        </details>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <AdminPagination
          pathname="/admin/audit"
          params={queryParams}
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
