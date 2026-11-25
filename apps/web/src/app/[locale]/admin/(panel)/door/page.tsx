import {
  DOOR_STATES,
  getCheckInStats,
  listDoorGuests,
  listScannerEventOptions,
  type DoorState,
} from '@tix/core';
import { parsePage, parsePageSize } from '@tix/shared';
import { Search } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { DoorGuestList } from '@/components/admin/door-guest-list';
import { FilterSelect } from '@/components/admin/filter-select';
import { PageHeader } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { buildQuery } from '@tix/shared';

export async function generateMetadata() {
  const t = await getTranslations('scanners.door');
  return { title: t('title') };
}

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
/** Events that started up to this long ago still count as "current" for the default selection. */
const CURRENT_WINDOW_MS = 12 * 3_600_000;

export default async function DoorPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER', 'DOOR_STAFF']);
  const sp = await searchParams;
  const core = getCore();
  const [t, tState, format, eventOptions] = await Promise.all([
    getTranslations('scanners.door'),
    getTranslations('scanners.door.state'),
    getFormatter(),
    listScannerEventOptions(core),
  ]);
  const usable = eventOptions.filter((e) => e.status !== 'DRAFT');
  const now = Date.now();
  const selected =
    usable.find((e) => e.id === sp.event) ??
    usable.find((e) => e.startsAt.getTime() >= now - CURRENT_WINDOW_MS) ??
    usable.at(-1);
  const state: DoorState = (DOOR_STATES as readonly string[]).includes(sp.state ?? '')
    ? (sp.state as DoorState)
    : 'ALL';
  const q = sp.q?.trim().slice(0, 80) || undefined;
  const page = parsePage(sp.page);
  const pageSize = parsePageSize(sp.pageSize, PAGE_SIZES, DEFAULT_PAGE_SIZE);

  const [stats, list] = selected
    ? await Promise.all([
        getCheckInStats(core, selected.id),
        listDoorGuests(core, { eventId: selected.id, q, state, page, pageSize }),
      ])
    : [null, null];
  const listParams = { event: selected?.id, q, state: state === 'ALL' ? undefined : state };
  const eventLabel = (e: (typeof usable)[number]) =>
    `${e.title} · ${format.dateTime(e.startsAt, { dateStyle: 'short' })}`;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-4 p-6">
        {!selected || !stats || !list ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('noEvents')}</p>
        ) : (
          <>
            <form className="flex flex-wrap items-end gap-2" action="" method="get">
              <FilterSelect
                name="event"
                value={selected.id}
                ariaLabel={t('event')}
                searchable={usable.length > 8}
                options={usable.map((e) => ({ value: e.id, label: eventLabel(e) }))}
              />
              <div className="relative min-w-56 flex-1">
                <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
                <Input
                  name="q"
                  type="search"
                  inputMode="search"
                  autoComplete="off"
                  defaultValue={q ?? ''}
                  placeholder={t('searchPlaceholder')}
                  className="h-9 pl-8"
                  aria-label={t('searchLabel')}
                />
              </div>
              {state !== 'ALL' && <input type="hidden" name="state" value={state} />}
              <Button type="submit" variant="secondary">
                {t('search')}
              </Button>
            </form>

            <div
              className="flex flex-wrap gap-x-6 gap-y-1 text-sm"
              data-testid="door-stats"
              aria-label={t('stats.label')}
            >
              <span>{t('stats.inside', { count: stats.checkedIn, total: stats.valid })}</span>
              <span className="text-muted-foreground">
                {t('stats.notArrived', { count: stats.notArrived })}
              </span>
              <span className="text-muted-foreground">
                {t('stats.out', { count: stats.checkedOut })}
              </span>
            </div>

            <div className="flex flex-wrap gap-2" role="group" aria-label={t('stateFilter')}>
              {DOOR_STATES.map((s) => (
                <Link
                  key={s}
                  href={buildQuery('/admin/door', listParams, {
                    state: s === 'ALL' ? undefined : s,
                  })}
                  aria-pressed={state === s}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm',
                    state === s
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'hover:bg-accent',
                  )}
                >
                  {tState(s)}
                </Link>
              ))}
            </div>

            {list.guests.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <DoorGuestList guests={list.guests} eventId={selected.id} />
            )}
            <AdminPagination
              pathname="/admin/door"
              params={listParams}
              page={page}
              pageSize={pageSize}
              defaultPageSize={DEFAULT_PAGE_SIZE}
              pageSizes={PAGE_SIZES}
              total={list.total}
              summary={t('total', { count: list.total })}
            />
          </>
        )}
      </div>
    </>
  );
}
