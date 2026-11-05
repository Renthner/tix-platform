import { computeSaleState } from '@tix/core';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { EventStatusBadge, SaleStateBadge } from '@/components/admin/badges';
import { EventTabs } from '@/components/admin/event-tabs';
import { PageHeader } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { formatInZone } from '@/lib/datetime';
import { requireAdmin } from '@/server/auth';
import { getEventWithVenue } from '@/server/admin/queries';

export default async function EventLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string; id: string }>;
}) {
  const locale = await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const { event, venue } = row;
  const t = await getTranslations('admin.events');
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
          <Button asChild variant="outline">
            <Link href="/admin/events">
              <ArrowLeft /> {t('backToList')}
            </Link>
          </Button>
        }
      />
      <EventTabs eventId={event.id} />
      <div className="p-6">{children}</div>
    </>
  );
}
