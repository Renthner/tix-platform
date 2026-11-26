import {
  DOOR_STATES,
  getCheckInStats,
  listDoorGuests,
  listScannerEventOptions,
  type DoorState,
} from '@tix/core';
import { parsePage, parsePageSize } from '@tix/shared';
import { CalendarX2, Search, UserSearch } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { DoorGuestList } from '@/components/admin/door-guest-list';
import { EmptyState } from '@/components/admin/empty-state';
import { FilterSelect } from '@/components/admin/filter-select';
import { AdminPageHeader } from '@/components/admin/page-header';
import { StatusTabs } from '@/components/admin/status-tabs';
import {
  AutoSubmitFallbackButton,
  AutoSubmitForm,
  AutoSubmitPending,
  FilterSearchInput,
} from '@/components/admin/auto-submit-form';
import { resolveLocale } from '@/i18n/locale';
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
  const insidePercent =
    stats && stats.valid > 0 ? Math.min(100, Math.round((stats.checkedIn / stats.valid) * 100)) : 0;
  const listParams = { event: selected?.id, q, state: state === 'ALL' ? undefined : state };
  const eventLabel = (e: (typeof usable)[number]) =>
    `${e.title} · ${format.dateTime(e.startsAt, { dateStyle: 'short' })}`;

  return (
    <>
      <AdminPageHeader title={t('title')} description={t('description')} />
      <div className="space-y-4 p-4 sm:p-6">
        {!selected || !stats || !list ? (
          <EmptyState icon={CalendarX2} title={t('noEvents')} />
        ) : (
          <>
            <AutoSubmitForm className="flex flex-wrap items-center gap-2">
              <FilterSelect
                name="event"
                value={selected.id}
                ariaLabel={t('event')}
                searchable={usable.length > 8}
                options={usable.map((e) => ({ value: e.id, label: eventLabel(e) }))}
              />
              <div className="relative min-w-56 flex-1">
                <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
                <FilterSearchInput
                  name="q"
                  inputMode="search"
                  autoComplete="off"
                  value={q ?? ''}
                  placeholder={t('searchPlaceholder')}
                  className="h-9 pl-8"
                  aria-label={t('searchLabel')}
                />
              </div>
              {state !== 'ALL' && <input type="hidden" name="state" value={state} />}
              <AutoSubmitPending />
              <AutoSubmitFallbackButton>{t('search')}</AutoSubmitFallbackButton>
            </AutoSubmitForm>

            <section
              className="grid gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]"
              data-testid="door-stats"
              aria-label={t('stats.label')}
            >
              <div className="min-w-0 space-y-2">
                <div className="text-sm text-muted-foreground">{tState('INSIDE')}</div>
                <div className="text-3xl font-semibold tabular-nums">
                  {stats.checkedIn}
                  <span className="text-xl text-muted-foreground"> / {stats.valid}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t('stats.label')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={insidePercent}
                  aria-valuetext={t('stats.inside', {
                    count: stats.checkedIn,
                    total: stats.valid,
                  })}
                  className="h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div className="h-full bg-success" style={{ width: `${insidePercent}%` }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:contents">
                <div className="min-w-0">
                  <div className="text-sm text-muted-foreground">{tState('NOT_ARRIVED')}</div>
                  <div className="text-2xl font-semibold tabular-nums">{stats.notArrived}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-sm text-muted-foreground">{tState('OUT')}</div>
                  <div className="text-2xl font-semibold text-warning tabular-nums">
                    {stats.checkedOut}
                  </div>
                </div>
              </div>
            </section>

            <StatusTabs
              label={t('stateFilter')}
              tabs={DOOR_STATES.map((s) => ({
                key: s,
                label: tState(s),
                href: buildQuery('/admin/door', listParams, {
                  state: s === 'ALL' ? undefined : s,
                }),
                active: state === s,
                'data-testid': `door-state-${s}`,
              }))}
            />

            {list.guests.length === 0 ? (
              <EmptyState icon={UserSearch} title={t('empty')} />
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
