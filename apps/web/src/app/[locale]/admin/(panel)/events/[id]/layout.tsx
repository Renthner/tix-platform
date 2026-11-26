import { computeSaleState, eventTranslationCompleteness } from '@tix/core';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { EventStatusBadge, SaleStateBadge } from '@/components/admin/badges';
import { EditLocaleSwitcher } from '@/components/admin/edit-locale-switcher';
import { EventActionsMenu } from '@/components/admin/event-actions-menu';
import { EventContentPane, EventNav } from '@/components/admin/event-nav';
import { AdminPageHeader } from '@/components/admin/page-header';
import { TranslationTabGate } from '@/components/admin/translation-tab-gate';
import { resolveLocale } from '@/i18n/locale';
import { formatInZone, utcToZonedWallTime } from '@/lib/datetime';
import { hasRole, requireAdmin } from '@/server/auth';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { getBaseContentLocale, getEditLocale } from '@/server/admin/edit-locale';
import { getCore } from '@/server/core';
import { duplicateEventAction } from '@/server/admin/events';
import { getEventWithVenue } from '@/server/admin/queries';

export default async function EventLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string; id: string }>;
}) {
  const locale = await resolveLocale(params);
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const { event, venue } = row;
  const [baseLocale, editLocale, completeness, breadcrumbs] = await Promise.all([
    getBaseContentLocale(),
    getEditLocale(),
    eventTranslationCompleteness(getCore(), event.id),
    hubBreadcrumbs('events'),
  ]);
  const shopHref = `/events/${event.slug}`;
  const testable =
    hasRole(session, ['SUPER_ADMIN']) &&
    (event.status === 'DRAFT' || event.status === 'PUBLISHED' || event.status === 'POSTPONED');
  const published = event.status === 'PUBLISHED' || event.status === 'POSTPONED';

  // md+: fixed header, the event menu and the page content scroll independently (the admin
  // layout makes `<main>` viewport-high for pages marked `data-admin-panes`). Phones: normal
  // window scrolling with a select as menu.
  return (
    <div data-admin-panes className="md:flex md:min-h-0 md:flex-1 md:flex-col">
      <div className="shrink-0">
        <AdminPageHeader
          breadcrumbs={breadcrumbs}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {event.title} <EventStatusBadge status={event.status} />{' '}
              <SaleStateBadge state={computeSaleState(event)} />
            </span>
          }
          description={`${formatInZone(event.startsAt, event.timeZone, locale, { dateStyle: 'full', timeStyle: 'short' })} · ${venue.name}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <EditLocaleSwitcher
                baseLocale={baseLocale}
                current={editLocale ?? baseLocale}
                options={Object.entries(completeness).map(([locale, c]) => ({ locale, ...c }))}
              />
              <EventActionsMenu
                duplicateAction={duplicateEventAction.bind(null, event.id)}
                title={event.title}
                startsAt={utcToZonedWallTime(event.startsAt, event.timeZone)}
                exportHref={`/api/admin/events/${event.id}/export`}
                testShopHref={testable ? shopHref : null}
                viewShopHref={published ? shopHref : null}
              />
            </div>
          }
        />
      </div>
      <div className="flex flex-col gap-6 p-6 md:min-h-0 md:flex-1 md:flex-row md:gap-0 md:p-0">
        <EventNav eventId={event.id} />
        <EventContentPane>
          <TranslationTabGate eventId={event.id} translating={editLocale !== null}>
            {children}
          </TranslationTabGate>
        </EventContentPane>
      </div>
    </div>
  );
}
