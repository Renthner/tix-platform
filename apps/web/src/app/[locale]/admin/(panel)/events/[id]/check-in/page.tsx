import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CheckInPanel, type CheckInFilters } from '@/components/admin/scanners/check-in-panel';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { getEventWithVenue } from '@/server/admin/queries';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('checkIn') };
}

export default async function EventCheckInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<CheckInFilters>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  return (
    <CheckInPanel
      eventId={row.event.id}
      basePath={`/admin/events/${row.event.id}/check-in`}
      filters={await searchParams}
    />
  );
}
