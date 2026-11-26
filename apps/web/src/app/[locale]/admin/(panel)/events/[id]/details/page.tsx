import { getMediaAsset } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EventDetailsForm } from '@/components/admin/event-forms';
import { EventTranslationPane } from '@/components/admin/event-translation-pane';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { utcToZonedWallTime } from '@/lib/datetime';
import { requireAdmin } from '@/server/auth';
import { getEditLocale } from '@/server/admin/edit-locale';
import { updateEventDetailsAction } from '@/server/admin/events';
import { getEventWithVenue, listTaxRates } from '@/server/admin/queries';
import { getCore } from '@/server/core';
import { descriptionToHtml } from '@/server/rich-text';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('details') };
}

export default async function EventDetailsPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const { event } = row;
  const editLocale = await getEditLocale();
  if (editLocale) {
    return <EventTranslationPane eventId={event.id} scope="event" editLocale={editLocale} />;
  }
  const [t, taxRates, cover] = await Promise.all([
    getTranslations('admin.events'),
    listTaxRates(),
    event.heroImageAssetId ? getMediaAsset(getCore(), event.heroImageAssetId) : null,
  ]);
  const tz = event.timeZone;

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>{t('details.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <EventDetailsForm
          action={updateEventDetailsAction.bind(null, event.id)}
          taxRates={taxRates.map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault }))}
          initial={{
            title: event.title,
            subtitle: event.subtitle,
            // Legacy plain-text descriptions keep their line breaks.
            description: descriptionToHtml(event.description),
            slug: event.slug,
            startsAt: utcToZonedWallTime(event.startsAt, tz),
            endsAt: utcToZonedWallTime(event.endsAt, tz),
            doorsOpenAt: utcToZonedWallTime(event.doorsOpenAt, tz),
            timeZone: tz,
            currency: event.currency,
            taxRateId: event.taxRateId,
            cover: cover
              ? {
                  id: cover.id,
                  fileName: cover.fileName,
                  width: cover.width,
                  height: cover.height,
                }
              : null,
          }}
        />
      </CardContent>
    </Card>
  );
}
