import { getSalesStatistics, parseStatisticsParams, statisticsFilterToParams } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import { StatisticsFilters } from '@/components/admin/statistics/statistics-filters';
import { StatisticsView } from '@/components/admin/statistics/statistics-view';
import { resolveLocale } from '@/i18n/locale';
import { listEvents } from '@/server/admin/queries';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('statistics');
  return { title: t('title') };
}

export default async function StatisticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER', 'FINANCE']);
  const filter = parseStatisticsParams(await searchParams);
  const [t, data, eventRows] = await Promise.all([
    getTranslations('statistics'),
    getSalesStatistics(getCore(), filter),
    listEvents(),
  ]);
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-6 p-4 sm:p-6">
        <StatisticsFilters
          key={statisticsFilterToParams(filter).toString()}
          events={eventRows.map(({ event }) => ({
            id: event.id,
            title: event.title,
            startsAt: event.startsAt.toISOString(),
          }))}
          preset={filter.preset}
          from={data.range.from}
          to={data.range.to}
          eventIds={filter.eventIds}
          channels={filter.channels}
          methods={filter.methods}
          exportQuery={statisticsFilterToParams(filter).toString()}
        />
        <StatisticsView data={data} />
      </div>
    </>
  );
}
