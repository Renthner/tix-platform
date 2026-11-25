import { listEventMailings, listMailingCategories } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EventMailingCard } from '@/components/admin/communication/event-mailing';
import { resolveLocale } from '@/i18n/locale';
import { getEventWithVenue } from '@/server/admin/queries';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('communication') };
}

export default async function EventCommunicationPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const core = getCore();
  const [history, categories] = await Promise.all([
    listEventMailings(core.db, id),
    listMailingCategories(core.db, id),
  ]);
  return (
    <div className="max-w-3xl">
      <EventMailingCard
        eventId={id}
        categories={categories}
        history={history.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }))}
      />
    </div>
  );
}
