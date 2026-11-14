import { computeSaleState, eventTranslationCompleteness } from '@tix/core';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { EventStatusBadge, SaleStateBadge } from '@/components/admin/badges';
import { EditLocaleSwitcher } from '@/components/admin/edit-locale-switcher';
import { TranslationTabGate } from '@/components/admin/translation-tab-gate';
import { EventDuplicateDialog } from '@/components/admin/event-duplicate-dialog';
import { EventTabs } from '@/components/admin/event-tabs';
import { PageHeader } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { formatInZone, utcToZonedWallTime } from '@/lib/datetime';
import { hasRole, requireAdmin } from '@/server/auth';
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
  const t = await getTranslations('admin.events');
  const [baseLocale, editLocale, completeness] = await Promise.all([
    getBaseContentLocale(),
    getEditLocale(),
    eventTranslationCompleteness(getCore(), event.id),
  ]);
  return (
    <>
      <PageHeader
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
            <EventDuplicateDialog
              action={duplicateEventAction.bind(null, event.id)}
              title={event.title}
              startsAt={utcToZonedWallTime(event.startsAt, event.timeZone)}
            />
            {hasRole(session, ['SUPER_ADMIN']) &&
              (event.status === 'DRAFT' ||
                event.status === 'PUBLISHED' ||
                event.status === 'POSTPONED') && (
                <Button asChild variant="outline">
                  <Link href={`/events/${event.slug}`} target="_blank" rel="noopener">
                    <FlaskConical /> {t('testInShop')}
                  </Link>
                </Button>
              )}
            <Button asChild variant="outline">
              <Link href="/admin/events">
                <ArrowLeft /> {t('backToList')}
              </Link>
            </Button>
          </div>
        }
      />
      <EventTabs eventId={event.id} />
      <div className="p-6">
        <TranslationTabGate eventId={event.id} translating={editLocale !== null}>
          {children}
        </TranslationTabGate>
      </div>
    </>
  );
}
