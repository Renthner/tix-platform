import {
  eventHasOrders,
  listEventCancellationRuns,
  previewEventCancellation,
  summarizeTestOrders,
} from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  EventCancellationCard,
  EventPostponeCard,
} from '@/components/admin/communication/event-cancellation';
import { EntityAuditCard } from '@/components/admin/entity-audit-card';
import { EventDangerZone } from '@/components/admin/event-danger-zone';
import { EventPublishCard } from '@/components/admin/event-publish-card';
import { EventTestOrdersCard } from '@/components/admin/event-test-orders-card';
import { resolveLocale } from '@/i18n/locale';
import { utcToZonedWallTime } from '@/lib/datetime';
import { hasRole, requireAdmin } from '@/server/auth';
import { deleteEventAction } from '@/server/admin/events';
import { deleteEventTestOrdersAction } from '@/server/admin/test-orders';
import { getEventWithVenue } from '@/server/admin/queries';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('status') };
}

/** Status & lifecycle: publishing, test orders, postponement, cancellation, history, deletion. */
export default async function EventStatusPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const { event } = row;
  const [hasOrders, testOrders] = await Promise.all([
    eventHasOrders(getCore(), event.id),
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

  return (
    <div className="max-w-4xl space-y-6">
      <EventPublishCard event={event} testOrders={testOrders} canDeleteTestOrders={isSuperAdmin} />
      {isSuperAdmin && testOrders.orders > 0 && (
        <EventTestOrdersCard
          action={deleteEventTestOrdersAction.bind(null, event.id)}
          orders={testOrders.orders}
          seats={testOrders.seats}
          withMoney={testOrders.withMoney}
        />
      )}
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
      <EntityAuditCard entityType="event" entityId={event.id} showFullLogLink={isSuperAdmin} />
      <EventDangerZone
        action={deleteEventAction.bind(null, event.id)}
        title={event.title}
        archived={event.status === 'ARCHIVED'}
        hasOrders={hasOrders}
      />
    </div>
  );
}
