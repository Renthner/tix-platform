import { events, orderFees, orderItems, orders, venues, type Executor } from '@tix/db';
import { localized, normalizeLocale } from '@tix/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import { getSetting } from '../settings';
import type { MailTranslator } from '../i18n/mail-messages';

/**
 * Everything generated documents (order e-mails, invoices) need about an order, loaded in
 * a few queries: the order snapshot, its items and fee lines and the events they belong to.
 */

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type OrderFeeRow = typeof orderFees.$inferSelect;

export interface DocumentEvent {
  id: string;
  title: string;
  subtitle: string | null;
  startsAt: Date;
  doorsOpenAt: Date | null;
  timeZone: string;
  taxRateId: string;
  venueName: string;
  venueCity: string | null;
  venueAddress: string | null;
}

export interface OrderDocumentData {
  order: OrderRow;
  items: OrderItemRow[];
  fees: OrderFeeRow[];
  /** Events of the order, chronologically. */
  events: DocumentEvent[];
  eventById: Map<string, DocumentEvent>;
}

const LABELS = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export async function loadOrderDocumentData(
  db: Executor,
  orderId: string,
): Promise<OrderDocumentData | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [items, fees] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id)),
    db.select().from(orderFees).where(eq(orderFees.orderId, orderId)).orderBy(asc(orderFees.id)),
  ]);
  const eventIds = [
    ...new Set([...items.map((i) => i.eventId), ...fees.flatMap((f) => f.eventId ?? [])]),
  ];
  const eventRows =
    eventIds.length === 0
      ? []
      : await db
          .select({
            id: events.id,
            title: events.title,
            translations: events.translations,
            subtitle: events.subtitle,
            startsAt: events.startsAt,
            doorsOpenAt: events.doorsOpenAt,
            timeZone: events.timeZone,
            taxRateId: events.taxRateId,
            venueName: venues.name,
            venueTranslations: venues.translations,
            street: venues.street,
            postalCode: venues.postalCode,
            city: venues.city,
          })
          .from(events)
          .innerJoin(venues, eq(venues.id, events.venueId))
          .where(inArray(events.id, eventIds))
          .orderBy(asc(events.startsAt));
  // Event texts follow the order's locale (item snapshots were stored in it at checkout).
  const defaultLocale = normalizeLocale(
    (await getSetting({ db: db as never }, 'general')).defaultLocale,
  );
  const documentEvents: DocumentEvent[] = eventRows.map((e) => ({
    id: e.id,
    title: localized(e, 'title', order.locale, defaultLocale),
    subtitle: e.subtitle === null ? null : localized(e, 'subtitle', order.locale, defaultLocale),
    startsAt: e.startsAt,
    doorsOpenAt: e.doorsOpenAt,
    timeZone: e.timeZone,
    taxRateId: e.taxRateId,
    venueName: localized(
      { translations: e.venueTranslations },
      'name',
      order.locale,
      defaultLocale,
      e.venueName,
    ),
    venueCity: e.city,
    venueAddress:
      [e.street, [e.postalCode, e.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') ||
      null,
  }));
  // Items in the chronological order of their events, then block / row / seat (numeric-aware).
  const rank = new Map(documentEvents.map((e, index) => [e.id, index]));
  items.sort(
    (a, b) =>
      (rank.get(a.eventId) ?? 0) - (rank.get(b.eventId) ?? 0) ||
      LABELS.compare(a.sectionLabel, b.sectionLabel) ||
      LABELS.compare(a.rowLabel ?? '', b.rowLabel ?? '') ||
      LABELS.compare(a.seatLabel ?? '', b.seatLabel ?? ''),
  );
  return {
    order,
    items,
    fees,
    events: documentEvents,
    eventById: new Map(documentEvents.map((e) => [e.id, e])),
  };
}

/** "Block A · Row 3 · Seat 12" / "Standing area · Floor" (localized). */
export function describeOrderItem(
  item: Pick<OrderItemRow, 'kind' | 'sectionLabel' | 'rowLabel' | 'seatLabel'>,
  t: MailTranslator,
): string {
  if (item.kind === 'GENERAL_ADMISSION' || !item.seatLabel) {
    return t('items.standing', { section: item.sectionLabel });
  }
  return item.rowLabel
    ? t('items.seat', { section: item.sectionLabel, row: item.rowLabel, seat: item.seatLabel })
    : t('items.seatWithoutRow', { section: item.sectionLabel, seat: item.seatLabel });
}

/** Items to list in documents: everything of a closed order, otherwise the live ones. */
export function documentItems(data: OrderDocumentData): OrderItemRow[] {
  const { order, items } = data;
  if (order.status === 'CANCELLED' || order.status === 'EXPIRED' || order.status === 'REFUNDED') {
    return items;
  }
  return items.filter((i) => i.status !== 'CANCELLED' && i.status !== 'REFUNDED');
}
