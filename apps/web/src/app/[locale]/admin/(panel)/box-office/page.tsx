import { getSetting, normalizeBuyerLocale } from '@tix/core';
import { events, venues } from '@tix/db';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { BoxOffice, type BoxOfficeEvent } from '@/components/admin/box-office/box-office';
import { PageHeader } from '@/components/admin/form-controls';
import { resolveLocale } from '@/i18n/locale';
import { BOX_OFFICE_ROLES, boxOfficePermissions } from '@/server/admin/box-office';
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('orders.boxOffice');
  return { title: t('title') };
}

/** Events that started less than this long ago still count as "running today". */
const RUNNING_WINDOW_MS = 12 * 60 * 60 * 1000;

export default async function BoxOfficePage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const session = await requireAdmin(BOX_OFFICE_ROLES);
  const core = getCore();
  const t = await getTranslations('orders.boxOffice');
  const [rows, seatDisplay, general] = await Promise.all([
    core.db
      .select({
        id: events.id,
        title: events.title,
        startsAt: events.startsAt,
        timeZone: events.timeZone,
        venueName: venues.name,
        hasSeatMap: sql<boolean>`${events.seatMapId} IS NOT NULL`,
      })
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(
        and(
          inArray(events.status, ['PUBLISHED', 'POSTPONED']),
          gte(events.startsAt, new Date(Date.now() - 30 * 86_400_000)),
        ),
      )
      .orderBy(asc(events.startsAt))
      .limit(200),
    getSetting(core, 'seatDisplay'),
    getSetting(core, 'general'),
  ]);
  // Running (started within the last hours) and upcoming events first; older ones last.
  const cutoff = Date.now() - RUNNING_WINDOW_MS;
  const sellable = rows.filter((e) => e.hasSeatMap);
  const eventList: BoxOfficeEvent[] = [
    ...sellable.filter((e) => e.startsAt.getTime() >= cutoff),
    ...sellable.filter((e) => e.startsAt.getTime() < cutoff).reverse(),
  ].map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    timeZone: e.timeZone,
    venueName: e.venueName,
  }));
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="p-6">
        <BoxOffice
          events={eventList}
          colors={seatDisplay}
          permissions={boxOfficePermissions(session)}
          defaultLocale={normalizeBuyerLocale(general.defaultLocale) ?? 'en'}
          canOpenOrders={hasRole(session, ['EVENT_MANAGER', 'FINANCE'])}
        />
      </div>
    </>
  );
}
