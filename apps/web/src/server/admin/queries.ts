import 'server-only';
import {
  accessCodes,
  events,
  priceCategories,
  priceCategoryTicketTypes,
  queueAnnouncements,
  queueConfigs,
  seatMapElements,
  seatMapSections,
  seatMaps,
  seats,
  taxRates,
  ticketTypes,
  venues,
  waitlistEntries,
} from '@tix/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { countSellableContingents } from '@tix/core';
import { getCore } from '@/server/core';
import { shopOrderBy, shopVisibleCondition } from '@/server/shop-events';

export type EventRow = typeof events.$inferSelect;
export type VenueRow = typeof venues.$inferSelect;

export async function listVenuesWithPlanCount() {
  const { db } = getCore();
  return db
    .select({
      id: venues.id,
      name: venues.name,
      city: venues.city,
      isActive: venues.isActive,
      plans:
        sql<number>`count(${seatMaps.id}) filter (where ${seatMaps.kind} = 'TEMPLATE')`.mapWith(
          Number,
        ),
    })
    .from(venues)
    .leftJoin(seatMaps, eq(seatMaps.venueId, venues.id))
    .groupBy(venues.id)
    .orderBy(asc(venues.name))
    .limit(500);
}

export async function getVenue(venueId: string): Promise<VenueRow | null> {
  if (!isUuid(venueId)) return null;
  const [venue] = await getCore().db.select().from(venues).where(eq(venues.id, venueId));
  return venue ?? null;
}

/** Number of events (any status) at a venue – a venue can only be deleted when 0. */
export async function countVenueEvents(venueId: string): Promise<number> {
  const [row] = await getCore()
    .db.select({ n: count() })
    .from(events)
    .where(eq(events.venueId, venueId));
  return row?.n ?? 0;
}

export async function listTemplates(venueId: string) {
  const { db } = getCore();
  return db
    .select({
      id: seatMaps.id,
      name: seatMaps.name,
      version: seatMaps.version,
      updatedAt: seatMaps.updatedAt,
      seats:
        sql<number>`(select count(*) from ${seats} where ${seats.seatMapId} = "seat_maps"."id" and ${seats.removedAt} is null)`.mapWith(
          Number,
        ),
    })
    .from(seatMaps)
    .where(and(eq(seatMaps.venueId, venueId), eq(seatMaps.kind, 'TEMPLATE')))
    .orderBy(asc(seatMaps.name));
}

export async function listAllTemplates() {
  const { db } = getCore();
  return db
    .select({ id: seatMaps.id, name: seatMaps.name, venueId: seatMaps.venueId })
    .from(seatMaps)
    .where(eq(seatMaps.kind, 'TEMPLATE'))
    .orderBy(asc(seatMaps.name));
}

export const EVENT_LIST_SORTS = ['date', 'title', 'venue', 'status'] as const;
export type EventListSort = (typeof EVENT_LIST_SORTS)[number];

/** Filters of the admin event list (search in title / venue, upcoming or past). */
export interface EventListFilter {
  status?: EventRow['status'];
  q?: string;
  /** `upcoming` = started less than a day ago or later; `past` = everything older. */
  time?: 'upcoming' | 'past';
}

function eventListConditions(filter: EventListFilter): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.status) conditions.push(eq(events.status, filter.status));
  const q = filter.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(events.title, like), ilike(venues.name, like))!);
  }
  if (filter.time === 'upcoming') {
    conditions.push(gte(events.startsAt, sql`now() - interval '1 day'`));
  } else if (filter.time === 'past') {
    conditions.push(lt(events.startsAt, sql`now() - interval '1 day'`));
  }
  return conditions.length ? and(...conditions) : undefined;
}

/** Paged event list with search, sort and time filter (default: newest first). */
export async function listEventsPage(
  filter: EventListFilter & {
    sort?: EventListSort;
    dir?: 'asc' | 'desc';
    page: number;
    pageSize: number;
  },
) {
  const { db } = getCore();
  const column = {
    date: events.startsAt,
    title: sql`lower(${events.title})`,
    venue: sql`lower(${venues.name})`,
    status: events.status,
  }[filter.sort ?? 'date'];
  const dir = filter.dir ?? 'desc';
  const where = eventListConditions(filter);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({ event: events, venueName: venues.name })
      .from(events)
      .leftJoin(venues, eq(venues.id, events.venueId))
      .where(where)
      .orderBy(dir === 'asc' ? asc(column) : desc(column), asc(events.id))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize),
    db
      .select({ n: count() })
      .from(events)
      .leftJoin(venues, eq(venues.id, events.venueId))
      .where(where),
  ]);
  return { rows, total: totalRow?.n ?? 0 };
}

/**
 * Confirmed (sold) tickets and total capacity (seats + standing places of the event's plan) per
 * event, for the list columns. Pure SQL, no live holds.
 */
export async function eventSoldCapacity(
  eventIds: string[],
): Promise<Map<string, { sold: number; capacity: number }>> {
  if (eventIds.length === 0) return new Map();
  const { db } = getCore();
  const scope = sql.join(
    eventIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (
    await db.execute<{ event_id: string; sold: number; capacity: number }>(sql`
      SELECT e.id AS event_id,
        (SELECT COUNT(*)::int FROM order_items i
          WHERE i.event_id = e.id AND i.status = 'CONFIRMED') AS sold,
        ((SELECT COUNT(*)::int FROM seats s
            WHERE s.seat_map_id = e.seat_map_id AND s.removed_at IS NULL)
         + (SELECT COALESCE(SUM(m.capacity), 0)::int FROM seat_map_sections m
            WHERE m.seat_map_id = e.seat_map_id AND m.type = 'STANDING'
              AND m.is_active AND m.removed_at IS NULL)) AS capacity
      FROM events e WHERE e.id IN (${scope})
    `)
  ).rows;
  return new Map(
    rows.map((r) => [r.event_id, { sold: Number(r.sold), capacity: Number(r.capacity) }]),
  );
}

export async function listEvents(
  filter: {
    status?: EventRow['status'];
    upcomingOnly?: boolean;
    /** Paging; without it the (capped) full list is returned. */
    page?: number;
    pageSize?: number;
  } = {},
) {
  const { db } = getCore();
  const conditions = [];
  if (filter.status) conditions.push(eq(events.status, filter.status));
  if (filter.upcomingOnly) conditions.push(gte(events.startsAt, sql`now() - interval '1 day'`));
  return db
    .select({ event: events, venueName: venues.name })
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(filter.upcomingOnly ? asc(events.startsAt) : desc(events.startsAt), asc(events.id))
    .limit(filter.pageSize ?? 500)
    .offset(filter.pageSize ? ((filter.page ?? 1) - 1) * filter.pageSize : 0);
}

/** Number of events (optionally of one status) – for paging the event list. */
export async function countEvents(status?: EventRow['status']): Promise<number> {
  const [row] = await getCore()
    .db.select({ n: count() })
    .from(events)
    .where(status ? eq(events.status, status) : undefined);
  return row?.n ?? 0;
}

/** Events currently listed in the shop, in shop order. */
export async function listShopVisibleEvents() {
  return getCore()
    .db.select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      timeZone: events.timeZone,
      shopSortOrder: events.shopSortOrder,
      venueName: venues.name,
    })
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .where(shopVisibleCondition())
    .orderBy(...shopOrderBy())
    .limit(200);
}

export async function getEventWithVenue(
  eventId: string,
): Promise<{ event: EventRow; venue: VenueRow | null } | null> {
  if (!isUuid(eventId)) return null;
  const [row] = await getCore()
    .db.select({ event: events, venue: venues })
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .where(eq(events.id, eventId));
  return row ?? null;
}

export async function listTaxRates() {
  return getCore()
    .db.select()
    .from(taxRates)
    .where(eq(taxRates.isActive, true))
    .orderBy(asc(taxRates.sortOrder), asc(taxRates.name));
}

/**
 * Publish checklist. Seated events: seatMap, category, tariff, inventory; admission-only events:
 * category, tariff, contingent (a sellable contingent – the core re-checks it when publishing).
 */
export type PublishChecklist = Partial<
  Record<'seatMap' | 'category' | 'tariff' | 'inventory' | 'contingent', boolean>
>;

export function checklistComplete(c: PublishChecklist): boolean {
  return Object.values(c).every(Boolean);
}

/** Everything an event needs before it can be published. */
export async function publishChecklist(event: EventRow): Promise<PublishChecklist> {
  const { db } = getCore();
  if (event.seatingMode === 'ADMISSION') {
    const [[categories], [offered], contingents] = await Promise.all([
      db
        .select({ n: count() })
        .from(priceCategories)
        .where(and(eq(priceCategories.eventId, event.id), eq(priceCategories.isActive, true))),
      db
        .select({ n: count() })
        .from(priceCategoryTicketTypes)
        .innerJoin(
          priceCategories,
          eq(priceCategories.id, priceCategoryTicketTypes.priceCategoryId),
        )
        .innerJoin(ticketTypes, eq(ticketTypes.id, priceCategoryTicketTypes.ticketTypeId))
        .where(
          and(
            eq(priceCategories.eventId, event.id),
            eq(priceCategories.isActive, true),
            eq(ticketTypes.isActive, true),
            eq(priceCategoryTicketTypes.isActive, true),
            sql`'ONLINE' = ANY(${ticketTypes.channels})`,
          ),
        ),
      countSellableContingents(db, event),
    ]);
    return {
      category: (categories?.n ?? 0) > 0,
      tariff: (offered?.n ?? 0) > 0,
      contingent: contingents > 0,
    };
  }
  const [[categories], [offered], [sellableSeats], [sellableAreas]] = await Promise.all([
    db
      .select({ n: count() })
      .from(priceCategories)
      .where(and(eq(priceCategories.eventId, event.id), eq(priceCategories.isActive, true))),
    db
      .select({ n: count() })
      .from(priceCategoryTicketTypes)
      .innerJoin(priceCategories, eq(priceCategories.id, priceCategoryTicketTypes.priceCategoryId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, priceCategoryTicketTypes.ticketTypeId))
      .where(
        and(
          eq(priceCategories.eventId, event.id),
          eq(priceCategories.isActive, true),
          eq(ticketTypes.isActive, true),
          eq(priceCategoryTicketTypes.isActive, true),
          sql`'ONLINE' = ANY(${ticketTypes.channels})`,
        ),
      ),
    event.seatMapId
      ? db
          .select({ n: count() })
          .from(seats)
          .where(
            and(
              eq(seats.seatMapId, event.seatMapId),
              isNull(seats.removedAt),
              isNull(seats.blockReason),
              isNotNull(seats.priceCategoryId),
            ),
          )
      : Promise.resolve([{ n: 0 }]),
    event.seatMapId
      ? db
          .select({ n: count() })
          .from(seatMapSections)
          .where(
            and(
              eq(seatMapSections.seatMapId, event.seatMapId),
              eq(seatMapSections.type, 'STANDING'),
              eq(seatMapSections.isActive, true),
              isNull(seatMapSections.removedAt),
              isNotNull(seatMapSections.priceCategoryId),
              sql`${seatMapSections.capacity} > 0`,
            ),
          )
      : Promise.resolve([{ n: 0 }]),
  ]);
  return {
    seatMap: event.seatMapId !== null,
    category: (categories?.n ?? 0) > 0,
    tariff: (offered?.n ?? 0) > 0,
    inventory: (sellableSeats?.n ?? 0) + (sellableAreas?.n ?? 0) > 0,
  };
}

export async function getPricing(eventId: string) {
  const { db } = getCore();
  const [categories, types, matrix] = await Promise.all([
    db
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, eventId))
      .orderBy(asc(priceCategories.sortOrder), asc(priceCategories.name)),
    db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, eventId))
      .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.name)),
    db
      .select({
        priceCategoryId: priceCategoryTicketTypes.priceCategoryId,
        ticketTypeId: priceCategoryTicketTypes.ticketTypeId,
        priceOverride: priceCategoryTicketTypes.priceOverride,
        discountKind: priceCategoryTicketTypes.discountKind,
        discountValue: priceCategoryTicketTypes.discountValue,
        isActive: priceCategoryTicketTypes.isActive,
      })
      .from(priceCategoryTicketTypes)
      .innerJoin(priceCategories, eq(priceCategories.id, priceCategoryTicketTypes.priceCategoryId))
      .where(eq(priceCategories.eventId, eventId)),
  ]);
  return { categories, types, matrix, waitlistCounts: await confirmedWaitlistByCategory(eventId) };
}

/** Confirmed waiting-list entries per price category (deleted together with the category). */
async function confirmedWaitlistByCategory(eventId: string): Promise<Map<string, number>> {
  const { db } = getCore();
  const rows = await db
    .select({ categoryId: waitlistEntries.categoryId, n: count() })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.eventId, eventId), isNotNull(waitlistEntries.confirmedAt)))
    .groupBy(waitlistEntries.categoryId);
  return new Map(rows.flatMap((r) => (r.categoryId ? [[r.categoryId, r.n] as const] : [])));
}

export interface SeatingSummary {
  seatsTotal: number;
  seatsBlocked: number;
  seatsWithoutCategory: number;
  perCategory: { categoryId: string | null; seats: number }[];
  standingAreas: number;
  standingCapacity: number;
  standingWithoutCategory: number;
  version: number;
}

export async function seatingSummary(seatMapId: string): Promise<SeatingSummary> {
  const { db } = getCore();
  const [perCategory, [blocked], standing, [map]] = await Promise.all([
    db
      .select({ categoryId: seats.priceCategoryId, seats: count() })
      .from(seats)
      .where(and(eq(seats.seatMapId, seatMapId), isNull(seats.removedAt)))
      .groupBy(seats.priceCategoryId),
    db
      .select({ n: count() })
      .from(seats)
      .where(
        and(eq(seats.seatMapId, seatMapId), isNull(seats.removedAt), isNotNull(seats.blockReason)),
      ),
    db
      .select({ capacity: seatMapSections.capacity, categoryId: seatMapSections.priceCategoryId })
      .from(seatMapSections)
      .where(
        and(
          eq(seatMapSections.seatMapId, seatMapId),
          eq(seatMapSections.type, 'STANDING'),
          isNull(seatMapSections.removedAt),
          eq(seatMapSections.isActive, true),
        ),
      ),
    db.select({ version: seatMaps.version }).from(seatMaps).where(eq(seatMaps.id, seatMapId)),
  ]);
  return {
    seatsTotal: perCategory.reduce((n, r) => n + r.seats, 0),
    seatsBlocked: blocked?.n ?? 0,
    seatsWithoutCategory: perCategory.find((r) => r.categoryId === null)?.seats ?? 0,
    perCategory,
    standingAreas: standing.length,
    standingCapacity: standing.reduce((n, s) => n + (s.capacity ?? 0), 0),
    standingWithoutCategory: standing.filter((s) => s.categoryId === null).length,
    version: map?.version ?? 0,
  };
}

export async function getQueueConfigRow(eventId: string | null) {
  const { db } = getCore();
  const [row] = await db
    .select()
    .from(queueConfigs)
    .where(eventId ? eq(queueConfigs.eventId, eventId) : isNull(queueConfigs.eventId));
  return row ?? null;
}

export async function listAnnouncements(eventId: string) {
  return getCore()
    .db.select()
    .from(queueAnnouncements)
    .where(eq(queueAnnouncements.eventId, eventId))
    .orderBy(desc(queueAnnouncements.publishedAt))
    .limit(50);
}

export async function listAccessCodes(eventId: string) {
  return getCore()
    .db.select()
    .from(accessCodes)
    .where(eq(accessCodes.eventId, eventId))
    .orderBy(desc(accessCodes.createdAt))
    .limit(1000);
}

/**
 * How often each symbol is used: seats (not removed), element styles (`style.symbolId`) and
 * seat-map default seat symbols (`settings.defaultSeatSymbolId`).
 */
export async function symbolUsage(): Promise<Map<string, number>> {
  const { db } = getCore();
  const elementSymbol = sql<string>`${seatMapElements.style}->>'symbolId'`;
  const mapSymbol = sql<string>`${seatMaps.settings}->>'defaultSeatSymbolId'`;
  const [bySeats, byElements, byMaps] = await Promise.all([
    db
      .select({ id: seats.symbolId, n: count() })
      .from(seats)
      .where(and(isNotNull(seats.symbolId), isNull(seats.removedAt)))
      .groupBy(seats.symbolId),
    db
      .select({ id: elementSymbol, n: count() })
      .from(seatMapElements)
      .where(sql`${elementSymbol} IS NOT NULL`)
      .groupBy(elementSymbol),
    db
      .select({ id: mapSymbol, n: count() })
      .from(seatMaps)
      .where(sql`${mapSymbol} IS NOT NULL`)
      .groupBy(mapSymbol),
  ]);
  const usage = new Map<string, number>();
  for (const row of [...bySeats, ...byElements, ...byMaps]) {
    if (row.id) usage.set(row.id, (usage.get(row.id) ?? 0) + row.n);
  }
  return usage;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
