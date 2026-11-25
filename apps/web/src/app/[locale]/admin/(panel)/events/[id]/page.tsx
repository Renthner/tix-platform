import {
  eventHasOrders,
  getMediaAsset,
  listEventCancellationRuns,
  previewEventCancellation,
  summarizeTestOrders,
} from '@tix/core';
import { EventTranslationPane } from '@/components/admin/event-translation-pane';
import { getEditLocale } from '@/server/admin/edit-locale';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EventDangerZone } from '@/components/admin/event-danger-zone';
import { EntityAuditCard } from '@/components/admin/entity-audit-card';
import { EventTestOrdersCard } from '@/components/admin/event-test-orders-card';
import {
  EventCancellationCard,
  EventPostponeCard,
} from '@/components/admin/communication/event-cancellation';
import { EventDetailsForm, EventStatusForm } from '@/components/admin/event-forms';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { utcToZonedWallTime } from '@/lib/datetime';
import { hasRole, requireAdmin } from '@/server/auth';
import {
  deleteEventAction,
  setEventStatusAction,
  updateEventDetailsAction,
} from '@/server/admin/events';
import { deleteEventTestOrdersAction } from '@/server/admin/test-orders';
import { getEventWithVenue, listTaxRates, publishChecklist } from '@/server/admin/queries';
import { getCore } from '@/server/core';
import { descriptionToHtml } from '@/server/rich-text';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const row = await getEventWithVenue((await params).id);
  return { title: row?.event.title ?? '–' };
}

export default async function EventDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ duplicated?: string; imported?: string }>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const { duplicated, imported } = await searchParams;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const { event } = row;
  const editLocale = await getEditLocale();
  if (editLocale) {
    return <EventTranslationPane eventId={event.id} scope="event" editLocale={editLocale} />;
  }
  const [t, taxRates, checklist, hasOrders, cover, testOrders] = await Promise.all([
    getTranslations('admin.events'),
    listTaxRates(),
    publishChecklist(event),
    eventHasOrders(getCore(), event.id),
    event.heroImageAssetId ? getMediaAsset(getCore(), event.heroImageAssetId) : null,
    summarizeTestOrders(getCore(), event.id),
  ]);
  const isSuperAdmin = hasRole(session, ['SUPER_ADMIN']);
  const cancellable =
    event.status === 'PUBLISHED' || event.status === 'POSTPONED' || event.status === 'CANCELLED';
  const [cancellationPreview, cancellationRuns] = cancellable
    ? await Promise.all([
        previewEventCancellation(getCore(), event.id),
        listEventCancellationRuns(getCore().db, event.id),
      ])
    : [null, []];
  const tz = event.timeZone;

  return (
    <div className="space-y-6">
      {duplicated && (
        <Alert>
          <AlertDescription>{t('duplicate.notice')}</AlertDescription>
        </Alert>
      )}
      {imported && (
        <Alert>
          <AlertDescription>{t('transfer.import.notice')}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Card>
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
        <div className="space-y-6">
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{t('publish.title')}</CardTitle>
              <CardDescription>{t('publish.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <EventStatusForm
                action={setEventStatusAction.bind(null, event.id)}
                status={event.status}
                checklist={checklist}
                testOrders={testOrders}
                canDeleteTestOrders={isSuperAdmin}
              />
            </CardContent>
          </Card>
          {isSuperAdmin && testOrders.orders > 0 && (
            <EventTestOrdersCard
              action={deleteEventTestOrdersAction.bind(null, event.id)}
              orders={testOrders.orders}
              seats={testOrders.seats}
              withMoney={testOrders.withMoney}
            />
          )}
          <EntityAuditCard entityType="event" entityId={event.id} showFullLogLink={isSuperAdmin} />
          {(event.status === 'PUBLISHED' || event.status === 'POSTPONED') && (
            <EventPostponeCard
              eventId={event.id}
              status={event.status}
              timeZone={event.timeZone}
              newStartsAt={utcToZonedWallTime(event.postponedNewStartsAt, event.timeZone)}
              note={event.postponementNote ?? ''}
            />
          )}
          {cancellationPreview &&
            (event.status === 'PUBLISHED' ||
              event.status === 'POSTPONED' ||
              event.status === 'CANCELLED') && (
              <EventCancellationCard
                eventId={event.id}
                status={event.status}
                currency={event.currency}
                preview={cancellationPreview}
                runs={cancellationRuns.map((r) => ({
                  ...r,
                  createdAt: r.createdAt.toISOString(),
                  finishedAt: r.finishedAt?.toISOString() ?? null,
                }))}
              />
            )}
          <EventDangerZone
            action={deleteEventAction.bind(null, event.id)}
            title={event.title}
            archived={event.status === 'ARCHIVED'}
            hasOrders={hasOrders}
          />
        </div>
      </div>
    </div>
  );
}
