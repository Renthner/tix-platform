import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminPageHeader } from '@/components/admin/page-header';
import { CheckInPanel, type CheckInFilters } from '@/components/admin/scanners/check-in-panel';
import { resolveLocale } from '@/i18n/locale';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { getEventWithVenue } from '@/server/admin/queries';
import { SCANNER_VIEW_ROLES } from '@/server/admin/scanners';
import { requireAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('scanners.checkIn');
  return { title: t('title') };
}

/** Read-only check-in overview for door staff (the event admin tab needs the event manager role). */
export default async function ScannerEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; eventId: string }>;
  searchParams: Promise<CheckInFilters>;
}) {
  await resolveLocale(params);
  await requireAdmin(SCANNER_VIEW_ROLES);
  const { eventId } = await params;
  const row = await getEventWithVenue(eventId);
  if (!row) notFound();
  const t = await getTranslations('scanners.checkIn');
  return (
    <>
      <AdminPageHeader
        breadcrumbs={await hubBreadcrumbs('scanners')}
        title={`${t('title')}: ${row.event.title}`}
        description={t('description')}
      />
      <div className="p-6">
        <CheckInPanel
          eventId={row.event.id}
          basePath={`/admin/scanners/events/${row.event.id}`}
          filters={await searchParams}
        />
      </div>
    </>
  );
}
