import { events, orderItems, orders, venues } from '@tix/db';
import { INVENTORY_HOLDING_ITEM_STATUSES, localized, venueMapsUrl } from '@tix/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { contentLocale } from '../content-locale';
import type { CoreContext } from '../context';
import { formatTime } from '../format';
import { mailTranslator } from '../i18n/mail-messages';
import { getSetting } from '../settings';
import { googleCalendarUrl, type CalendarEvent } from './ics';

export interface CalendarEventDetail extends CalendarEvent {
  slug: string;
  timeZone: string;
  /** Google Maps link (venue's own link, else from coordinates / address). */
  directionsUrl: string;
  googleUrl: string;
}

/** Host name for UIDs (shop host, `tix` without a public URL). */
export function calendarUidHost(ctx: Pick<CoreContext, 'appUrl'>): string {
  try {
    return ctx.appUrl ? new URL(ctx.appUrl).hostname : 'tix';
  } catch {
    return 'tix';
  }
}

/**
 * Calendar data of events in the requested locale: title, start / end (end defaults to the start
 * plus `general.defaultEventDurationMinutes`), location, event page, organiser. Unknown ids are
 * skipped; the result is chronological.
 */
export async function loadCalendarEvents(
  ctx: CoreContext,
  eventIds: string[],
  locale?: string | null,
): Promise<CalendarEventDetail[]> {
  if (eventIds.length === 0) return [];
  const [{ locale: loc, defaultLocale }, general, organizer] = await Promise.all([
    contentLocale(ctx, locale),
    getSetting(ctx, 'general'),
    getSetting(ctx, 'organizer'),
  ]);
  const t = mailTranslator(loc);
  const rows = await ctx.db
    .select({ event: events, venue: venues })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(inArray(events.id, eventIds))
    .orderBy(asc(events.startsAt), asc(events.id));
  const organizerName = organizer.legalName ?? general.shopName;
  return rows.map(({ event, venue }) => {
    const title = localized(event, 'title', loc, defaultLocale);
    const subtitle = event.subtitle ? localized(event, 'subtitle', loc, defaultLocale) : '';
    const venueName = localized(venue, 'name', loc, defaultLocale, venue.name);
    const address = [venue.street, [venue.postalCode, venue.city].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');
    const url = ctx.appUrl ? `${ctx.appUrl}/${loc}/events/${encodeURIComponent(event.slug)}` : null;
    const description = [
      subtitle,
      event.doorsOpenAt
        ? t('calendar.doors', { time: formatTime(event.doorsOpenAt, loc, event.timeZone) })
        : '',
      organizer.email ? '' : t('calendar.organizer', { name: organizerName }),
      url ? `${t('calendar.eventPage')}: ${url}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const detail: CalendarEvent = {
      id: event.id,
      title,
      description: description || null,
      startsAt: event.startsAt,
      endsAt:
        event.endsAt ??
        new Date(event.startsAt.getTime() + general.defaultEventDurationMinutes * 60_000),
      location: [venueName, address].filter(Boolean).join(', ') || null,
      latitude: venue.latitude,
      longitude: venue.longitude,
      url,
      organizerName,
      organizerEmail: organizer.email ?? null,
    };
    return {
      ...detail,
      slug: event.slug,
      timeZone: event.timeZone,
      directionsUrl: venueMapsUrl({ ...venue, name: venueName }),
      googleUrl: googleCalendarUrl(detail),
    };
  });
}

/** Events of an order that still hold seats (pending or confirmed items), chronological. */
export async function loadOrderCalendarEvents(
  ctx: CoreContext,
  orderId: string,
  options: { locale?: string | null; eventId?: string } = {},
): Promise<CalendarEventDetail[]> {
  const [order] = await ctx.db
    .select({ locale: orders.locale })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return [];
  const rows = await ctx.db
    .selectDistinct({ eventId: orderItems.eventId })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, orderId),
        inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
        options.eventId ? eq(orderItems.eventId, options.eventId) : undefined,
      ),
    );
  return loadCalendarEvents(
    ctx,
    rows.map((r) => r.eventId),
    options.locale ?? order.locale,
  );
}

/** Relative download path of an order's calendar file (all events, or one with `eventId`). */
export function orderCalendarPath(
  token: string,
  orderId: string,
  eventId?: string,
): string {
  const query = new URLSearchParams({ t: token });
  if (eventId) query.set('event', eventId);
  return `/api/orders/${orderId}/calendar.ics?${query.toString()}`;
}
