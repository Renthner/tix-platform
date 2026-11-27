import { computeSaleState } from '@tix/core';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_SIZES,
  EVENT_STATUSES,
  buildQuery,
  parsePage,
  parsePageSize,
  type EventStatus,
} from '@tix/shared';
import { ArrowDown, ArrowUp, ArrowUpDown, ImageIcon, Plus, Search } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { EventStatusBadge, SaleStateBadge } from '@/components/admin/badges';
import { AdminPagination } from '@/components/admin/admin-pagination';
import {
  AutoSubmitFallbackButton,
  AutoSubmitForm,
  AutoSubmitPending,
  FilterSearchInput,
} from '@/components/admin/auto-submit-form';
import { EventRowActions } from '@/components/admin/event-row-actions';
import { FilterSelect } from '@/components/admin/filter-select';
import { EventImportDialog } from '@/components/admin/event-import-dialog';
import { AdminPageHeader } from '@/components/admin/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { formatInZone, utcToZonedWallTime } from '@/lib/datetime';
import { cn } from '@/lib/utils';
import { MediaThumb } from '@/components/media-image';
import { requireAdmin } from '@/server/auth';
import { duplicateEventAction } from '@/server/admin/events';
import {
  EVENT_LIST_SORTS,
  eventSoldCapacity,
  listEventsPage,
  listVenuesWithPlanCount,
  type EventListSort,
} from '@/server/admin/queries';

export async function generateMetadata() {
  const t = await getTranslations('admin.events');
  return { title: t('title') };
}

export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const locale = await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const sp = await searchParams;
  const { status, deleted, page: rawPage, pageSize: rawSize } = sp;
  const page = parsePage(rawPage);
  const pageSize = parsePageSize(rawSize);
  const filter = (EVENT_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as EventStatus)
    : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const time = sp.time === 'upcoming' || sp.time === 'past' ? sp.time : undefined;
  const sort = (EVENT_LIST_SORTS as readonly string[]).includes(sp.sort ?? '')
    ? (sp.sort as EventListSort)
    : undefined;
  const dir = sort ? (sp.dir === 'asc' ? 'asc' : 'desc') : undefined;
  const [t, ts, list, venues] = await Promise.all([
    getTranslations('admin.events'),
    getTranslations('admin.eventStatus'),
    listEventsPage({ status: filter, q, time, sort, dir, page, pageSize }),
    listVenuesWithPlanCount(),
  ]);
  const rows = list.rows;
  const total = list.total;
  const stock = await eventSoldCapacity(rows.map((r) => r.event.id));
  const listParams = { status: filter, q, time, sort, dir };
  const sortHead = (key: EventListSort, label: string) => {
    const active = (sort ?? 'date') === key ? (sort ? (dir ?? 'desc') : 'desc') : null;
    const next =
      active === 'asc' ? 'desc' : active === 'desc' ? 'asc' : key === 'date' ? 'desc' : 'asc';
    const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown;
    return (
      <TableHead
        aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined}
      >
        <Link
          href={buildQuery('/admin/events', listParams, { sort: key, dir: next })}
          className="inline-flex items-center gap-1 hover:underline"
        >
          {label}
          <Icon className="size-3.5 opacity-70" aria-hidden />
        </Link>
      </TableHead>
    );
  };

  return (
    <>
      <AdminPageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex gap-2">
            <EventImportDialog
              venues={venues.filter((v) => v.isActive).map((v) => ({ id: v.id, name: v.name }))}
            />
            <Button asChild variant="outline">
              <Link href="/admin/events/shop-order">
                <ArrowUpDown /> {t('shopOrder')}
              </Link>
            </Button>
            <Button asChild>
              <Link href="/admin/events/new">
                <Plus /> {t('new')}
              </Link>
            </Button>
          </div>
        }
      />
      <div className="space-y-4 p-6">
        {deleted && (
          <Alert>
            <AlertDescription>{t('deletedNotice')}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2 text-sm">
          {[undefined, ...EVENT_STATUSES].map((s) => (
            <Link
              key={s ?? 'all'}
              href={buildQuery('/admin/events', listParams, { status: s })}
              className={cn(
                'rounded-full border px-3 py-1',
                filter === s
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent',
              )}
            >
              {s ? ts(s) : t('filterAll')}
            </Link>
          ))}
        </div>
        <AutoSubmitForm role="search" className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <FilterSearchInput
              name="q"
              value={q ?? ''}
              placeholder={t('search.placeholder')}
              aria-label={t('search.label')}
              className="pl-8"
            />
          </div>
          <FilterSelect
            name="time"
            value={time}
            ariaLabel={t('search.time')}
            allLabel={t('search.timeAll')}
            options={[
              { value: 'upcoming', label: t('search.upcoming') },
              { value: 'past', label: t('search.past') },
            ]}
          />
          {filter && <input type="hidden" name="status" value={filter} />}
          {sort && <input type="hidden" name="sort" value={sort} />}
          {sort && dir && <input type="hidden" name="dir" value={dir} />}
          <AutoSubmitFallbackButton>{t('search.apply')}</AutoSubmitFallbackButton>
          <AutoSubmitPending />
        </AutoSubmitForm>
        <Card>
          <CardContent>
            {rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {sortHead('title', t('columns.title'))}
                    {sortHead('date', t('columns.date'))}
                    {sortHead('venue', t('columns.venue'))}
                    {sortHead('status', t('columns.status'))}
                    <TableHead>{t('columns.sale')}</TableHead>
                    <TableHead className="text-right">{t('columns.sold')}</TableHead>
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ event, venueName }) => (
                    <TableRow
                      key={event.id}
                      data-testid="event-row"
                      className="relative cursor-pointer focus-within:bg-muted/50"
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-3">
                          <div
                            data-testid="event-cover-thumb"
                            className="flex h-10 w-16 shrink-0 items-center justify-center"
                          >
                            {event.heroImageAssetId ? (
                              // Original aspect ratio, scaled into the fixed slot (names stay aligned).
                              <MediaThumb
                                assetId={event.heroImageAssetId}
                                variantWidth={320}
                                alt=""
                                className="h-auto max-h-10 w-auto max-w-16 rounded"
                              />
                            ) : (
                              <span className="flex size-full items-center justify-center rounded bg-muted text-muted-foreground">
                                <ImageIcon className="size-4" aria-hidden />
                              </span>
                            )}
                          </div>
                          <Link
                            href={`/admin/events/${event.id}`}
                            className="outline-none after:absolute after:inset-0 hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                          >
                            {event.title}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatInZone(event.startsAt, event.timeZone, locale)}
                      </TableCell>
                      <TableCell>{venueName ?? '–'}</TableCell>
                      <TableCell>
                        <EventStatusBadge status={event.status} />
                      </TableCell>
                      <TableCell>
                        <SaleStateBadge state={computeSaleState(event)} />
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {stock.get(event.id)?.sold ?? 0} / {stock.get(event.id)?.capacity ?? 0}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="relative z-10 inline-flex">
                          <EventRowActions
                            duplicateAction={duplicateEventAction.bind(null, event.id)}
                            title={event.title}
                            startsAt={utcToZonedWallTime(event.startsAt, event.timeZone)}
                            exportHref={`/api/admin/events/${event.id}/export`}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <AdminPagination
          pathname="/admin/events"
          params={listParams}
          page={page}
          pageSize={pageSize}
          defaultPageSize={DEFAULT_PAGE_SIZE}
          pageSizes={DEFAULT_PAGE_SIZES}
          total={total}
          summary={t('total', { count: total })}
        />
      </div>
    </>
  );
}
