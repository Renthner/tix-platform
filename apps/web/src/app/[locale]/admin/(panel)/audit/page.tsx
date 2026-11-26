import {
  listAuditActors,
  listAuditFilterOptions,
  listAuditLogs,
  redactAuditValue,
} from '@tix/core';
import { buildQuery, parsePage, parsePageSize } from '@tix/shared';
import { Download, ScrollText } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { EmptyState } from '@/components/admin/empty-state';
import { FilterSelect } from '@/components/admin/filter-select';
import {
  ListToolbar,
  MoreFilterField,
  type ActiveFilterChip,
} from '@/components/admin/list-toolbar';
import { AdminPageHeader } from '@/components/admin/page-header';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
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
  const [t, tl, format, result, options, actors] = await Promise.all([
    getTranslations('audit'),
    getTranslations('admin.list'),
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

  // Active filters as removable chips (the page size stays) and the reset link.
  const base = '/admin/audit';
  const keptPageSize = pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined;
  const without = (overrides: Record<string, string | undefined>) =>
    buildQuery(base, queryParams, { pageSize: keptPageSize, ...overrides });
  const chips: ActiveFilterChip[] = [];
  if (queryParams.q) {
    chips.push({
      key: 'q',
      label: tl('searchChip', { value: queryParams.q }),
      removeHref: without({ q: undefined }),
    });
  }
  if (queryParams.action) {
    chips.push({
      key: 'action',
      label: `${t('filters.action')}: ${queryParams.action.replace(/\.$/, '')}.*`,
      removeHref: without({ action: undefined }),
    });
  }
  if (queryParams.entityType) {
    chips.push({
      key: 'entityType',
      label: `${t('filters.entityType')}: ${queryParams.entityType}`,
      removeHref: without({ entityType: undefined }),
    });
  }
  if (queryParams.actor) {
    const actor = actors.find((x) => x.id === queryParams.actor);
    chips.push({
      key: 'actor',
      label: `${t('filters.actor')}: ${actor?.label ?? queryParams.actor}`,
      removeHref: without({ actor: undefined }),
    });
  }
  if (queryParams.from) {
    chips.push({
      key: 'from',
      label: `${t('filters.from')}: ${queryParams.from}`,
      removeHref: without({ from: undefined }),
    });
  }
  if (queryParams.to) {
    chips.push({
      key: 'to',
      label: `${t('filters.to')}: ${queryParams.to}`,
      removeHref: without({ to: undefined }),
    });
  }
  const resetHref = chips.length > 0 ? buildQuery(base, { pageSize: keptPageSize }) : null;
  const dateClass =
    'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm font-normal text-foreground';

  return (
    <>
      <AdminPageHeader
        breadcrumbs={await hubBreadcrumbs('administration')}
        title={t('title')}
        description={t('description')}
      />
      <div className="space-y-4 p-4 sm:p-6">
        <ListToolbar
          data-testid="audit-toolbar"
          search={{ value: filter.q, placeholder: t('searchPlaceholder') }}
          filters={
            <>
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
            </>
          }
          moreActiveCount={[queryParams.from, queryParams.to].filter(Boolean).length}
          moreFilters={
            <div className="grid grid-cols-2 gap-2">
              <MoreFilterField label={t('filters.from')}>
                <input
                  type="date"
                  name="from"
                  defaultValue={queryParams.from ?? ''}
                  className={dateClass}
                />
              </MoreFilterField>
              <MoreFilterField label={t('filters.to')}>
                <input
                  type="date"
                  name="to"
                  defaultValue={queryParams.to ?? ''}
                  className={dateClass}
                />
              </MoreFilterField>
            </div>
          }
          hidden={{ pageSize: keptPageSize }}
          resetHref={resetHref}
          chips={chips}
          actions={
            <Button asChild variant="outline">
              <a href={exportHref} download data-testid="audit-export">
                <Download /> {t('export')}
              </a>
            </Button>
          }
        />
        <p className="text-xs text-muted-foreground">{t('exportHint')}</p>
        <Card>
          <CardContent className={result.rows.length === 0 ? undefined : 'p-0'}>
            {result.rows.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                title={t('empty')}
                description={resetHref ? tl('emptyFiltered') : undefined}
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
                    <TableHead>{t('columns.time')}</TableHead>
                    <TableHead>{t('columns.actor')}</TableHead>
                    <TableHead>{t('columns.action')}</TableHead>
                    <TableHead>{t('columns.entity')}</TableHead>
                    <TableHead>{t('columns.ip')}</TableHead>
                    <TableHead>{t('columns.details')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow key={row.id} className="align-top">
                      <TableCell className="whitespace-nowrap">
                        {format.dateTime(row.createdAt, {
                          dateStyle: 'medium',
                          timeStyle: 'medium',
                        })}
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
            )}
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
