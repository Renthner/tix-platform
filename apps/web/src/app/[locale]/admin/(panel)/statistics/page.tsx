import { getSalesStatistics, parseStatisticsParams, statisticsFilterToParams } from '@tix/core';
import { Download } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminPageHeader } from '@/components/admin/page-header';
import { StatisticsFilters } from '@/components/admin/statistics/statistics-filters';
import { StatisticsView } from '@/components/admin/statistics/statistics-view';
import { Button } from '@/components/ui/button';
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
  const locale = await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER', 'FINANCE']);
  const filter = parseStatisticsParams(await searchParams);
  const [t, data, eventRows] = await Promise.all([
    getTranslations('statistics'),
    getSalesStatistics(getCore(), filter),
    listEvents(),
  ]);
  const filterQuery = statisticsFilterToParams(filter).toString();
  return (
    <>
      <AdminPageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild variant="outline">
            <a
              href={`/api/admin/statistics/export?${filterQuery}&locale=${locale}`}
              download
              data-testid="statistics-export"
            >
              <Download /> {t('filters.exportCsv')}
            </a>
          </Button>
        }
      />
      <div className="space-y-6 p-4 sm:p-6">
        <StatisticsFilters
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
        />
        <StatisticsView data={data} />
      </div>
    </>
  );
}
