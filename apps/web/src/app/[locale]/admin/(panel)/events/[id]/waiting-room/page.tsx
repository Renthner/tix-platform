import { getTranslations } from 'next-intl/server';
import { EventTranslationPane } from '@/components/admin/event-translation-pane';
import { getBaseContentLocale, getEditLocale } from '@/server/admin/edit-locale';
import { translationLocales } from '@tix/shared';
import { notFound } from 'next/navigation';
import {
  Announcements,
  QueueConfigForm,
  QueueResetButton,
  QueueStats,
} from '@/components/admin/queue-forms';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { getEventWithVenue, listAnnouncements } from '@/server/admin/queries';
import { queueFormValues } from '@/server/admin/queue-defaults';
import {
  createAnnouncementAction,
  expireAnnouncementAction,
  updateAnnouncementAction,
  resetQueueAction,
  saveQueueConfigAction,
} from '@/server/admin/queue';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('waitingRoom') };
}

export default async function EventWaitingRoomPage({
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
    return <EventTranslationPane eventId={event.id} scope="waitingRoom" editLocale={editLocale} />;
  }
  const [t, form, stats, announcements] = await Promise.all([
    getTranslations('admin.queue'),
    queueFormValues(event.id),
    getCore().queue.snapshot(event.id),
    listAnnouncements(event.id),
  ]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('stats.title')}</CardTitle>
          <CardDescription>{t('stats.description')}</CardDescription>
          <CardAction>
            <QueueResetButton action={resetQueueAction.bind(null, event.id)} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <QueueStats stats={stats} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('eventTitle')}</CardTitle>
          <CardDescription>{t('eventDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <QueueConfigForm
            action={saveQueueConfigAction.bind(null, event.id)}
            initial={form.values}
            scope="event"
            usesGlobal={!form.hasOwnRow}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('announcements.title')}</CardTitle>
          <CardDescription>{t('announcements.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Announcements
            create={createAnnouncementAction.bind(null, event.id)}
            translationLocales={translationLocales(await getBaseContentLocale())}
            items={announcements.map((a) => ({
              id: a.id,
              message: a.message,
              severity: a.severity,
              publishedAt: a.publishedAt.toISOString(),
              expiresAt: a.expiresAt?.toISOString() ?? null,
              translations: a.translations,
              expire: expireAnnouncementAction.bind(null, a.id),
              edit: updateAnnouncementAction.bind(null, a.id),
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
