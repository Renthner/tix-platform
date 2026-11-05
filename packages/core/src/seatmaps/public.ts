import {
  priceCategories,
  priceCategoryTicketTypes,
  seatMapElements,
  seatMapEntrances,
  seatMapRows,
  seatMapSections,
  seatMaps,
  seats,
  ticketTypes,
} from '@tix/db';
import {
  PUBLIC_MAP_FORMAT,
  SEAT_FLAG,
  companionPartners,
  computeTicketPrice,
  type PublicSeatMap,
  type PublicTicketType,
} from '@tix/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import type { EventRow } from '../events';
import { symbolsByIds } from '../symbols';

/**
 * Public seating plan of an event (no availability). Cached in Redis per seat map version
 * (shared by all processes) and in a small in-process LRU for hot events, so 1,000+
 * simultaneous page loads cost one build.
 */

const LOCAL_MAX = 32;
/**
 * In-process copies expire quickly so pricing changes made through another web instance
 * (which only clears Redis and its own memory) become visible everywhere within seconds.
 */
const LOCAL_TTL_MS = 10_000;
const local = new Map<string, { map: PublicSeatMap; expires: number }>();

const VERSION_TTL_MS = 1_000;
const versionCache = new Map<string, { version: number; expires: number }>();

/** Current seat map version (cached for 1 s – saves broadcast the new version anyway). */
export async function seatMapVersion(
  ctx: Pick<CoreContext, 'db'>,
  seatMapId: string,
): Promise<number> {
  const hit = versionCache.get(seatMapId);
  if (hit && hit.expires > Date.now()) return hit.version;
  const [row] = await ctx.db
    .select({ version: seatMaps.version })
    .from(seatMaps)
    .where(eq(seatMaps.id, seatMapId));
  if (!row) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Seat map not found', 404);
  versionCache.set(seatMapId, { version: row.version, expires: Date.now() + VERSION_TTL_MS });
  if (versionCache.size > 500) versionCache.delete(versionCache.keys().next().value!);
  return row.version;
}

/** Forgets the cached version (call right after saving a seat map in this process). */
export function forgetSeatMapVersion(seatMapId: string): void {
  versionCache.delete(seatMapId);
}

export async function getPublicSeatMap(ctx: CoreContext, event: EventRow): Promise<PublicSeatMap> {
  if (!event.seatMapId) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  const version = await seatMapVersion(ctx, event.seatMapId);
  const cacheKey = `${event.id}:${version}:${PUBLIC_MAP_FORMAT}`;
  const hit = local.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.map;

  const redisKey = ctx.keys.seatMapSnapshot(event.id, version, PUBLIC_MAP_FORMAT);
  const cached = await ctx.redis.get(redisKey);
  let map: PublicSeatMap;
  if (cached) {
    map = JSON.parse(cached) as PublicSeatMap;
  } else {
    map = await buildPublicSeatMap(ctx, event, event.seatMapId, version);
    await ctx.redis.set(redisKey, JSON.stringify(map), 'EX', 3600);
  }
  local.set(cacheKey, { map, expires: Date.now() + LOCAL_TTL_MS });
  if (local.size > LOCAL_MAX) local.delete(local.keys().next().value!);
  return map;
}

/** Drops cached snapshots of an event (prices or tariffs changed without a map save). */
export async function invalidatePublicSeatMap(
  ctx: CoreContext,
  eventId: string,
  version: number,
): Promise<void> {
  for (const key of local.keys()) if (key.startsWith(`${eventId}:`)) local.delete(key);
  await ctx.redis.del(ctx.keys.seatMapSnapshot(eventId, version, PUBLIC_MAP_FORMAT));
}

async function buildPublicSeatMap(
  ctx: CoreContext,
  event: EventRow,
  seatMapId: string,
  version: number,
): Promise<PublicSeatMap> {
  const db = ctx.db;
  const [map] = await db.select().from(seatMaps).where(eq(seatMaps.id, seatMapId));
  if (!map) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Seat map not found', 404);

  const [categories, types, sections, rows, elements, entrances, seatRows] = await Promise.all([
    db
      .select()
      .from(priceCategories)
      .where(and(eq(priceCategories.eventId, event.id), eq(priceCategories.isActive, true)))
      .orderBy(asc(priceCategories.sortOrder), asc(priceCategories.name)),
    db
      .select()
      .from(ticketTypes)
      .where(and(eq(ticketTypes.eventId, event.id), eq(ticketTypes.isActive, true)))
      .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.name)),
    db
      .select()
      .from(seatMapSections)
      .where(
        and(
          eq(seatMapSections.seatMapId, seatMapId),
          isNull(seatMapSections.removedAt),
          eq(seatMapSections.isActive, true),
        ),
      )
      .orderBy(asc(seatMapSections.sortOrder)),
    db
      .select()
      .from(seatMapRows)
      .where(and(eq(seatMapRows.seatMapId, seatMapId), isNull(seatMapRows.removedAt))),
    db.select().from(seatMapElements).where(eq(seatMapElements.seatMapId, seatMapId)),
    db.select().from(seatMapEntrances).where(eq(seatMapEntrances.seatMapId, seatMapId)),
    db
      .select()
      .from(seats)
      .where(and(eq(seats.seatMapId, seatMapId), isNull(seats.removedAt))),
  ]);

  // Companion seats → their wheelchair space(s) (explicit assignment or direct neighbour).
  const partners = companionPartners(
    seatRows.map((s) => ({
      id: s.id,
      parentId: s.rowId ?? s.tableElementId,
      position: s.position,
      isWheelchairSpace: s.isWheelchairSpace,
      isCompanionSeat: s.isCompanionSeat,
      companionOfSeatId: s.companionOfSeatId,
    })),
  );

  const onlineTypes = types.filter((t) => t.channels.includes('ONLINE'));
  const matrix = onlineTypes.length
    ? await db
        .select()
        .from(priceCategoryTicketTypes)
        .where(
          and(
            inArray(
              priceCategoryTicketTypes.ticketTypeId,
              onlineTypes.map((t) => t.id),
            ),
            eq(priceCategoryTicketTypes.isActive, true),
          ),
        )
    : [];

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const ticketTypeList: PublicTicketType[] = onlineTypes.map((t) => {
    const prices: Record<string, number> = {};
    for (const m of matrix) {
      if (m.ticketTypeId !== t.id) continue;
      const category = categoryById.get(m.priceCategoryId);
      if (!category) continue;
      prices[category.id] = computeTicketPrice(category.basePrice, t, {
        priceOverride: m.priceOverride,
        discountKind: m.discountKind,
        discountValue: m.discountValue,
      }).priceGross;
    }
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      isDefault: t.isDefault,
      requiresProofAtEntry: t.requiresProofAtEntry,
      requiredSeatFeature: t.requiredSeatFeature,
      maxPerOrder: t.maxPerOrder,
      sortOrder: t.sortOrder,
      prices,
    };
  });

  const activeSections = new Set(sections.map((s) => s.id));
  return {
    eventId: event.id,
    version,
    canvasWidth: map.canvasWidth,
    canvasHeight: map.canvasHeight,
    settings: map.settings,
    backgroundUrl: null,
    currency: event.currency,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      basePrice: c.basePrice,
      sortOrder: c.sortOrder,
      maxPerOrder: c.maxTicketsPerOrder,
    })),
    ticketTypes: ticketTypeList,
    sections: sections.map((s) => ({
      id: s.id,
      type: s.type,
      name: s.name,
      ticketLabel: s.ticketLabel,
      geometry: s.geometry,
      label: s.label,
      color: s.color,
      priceCategoryId: s.priceCategoryId,
      isBestAvailableEnabled: s.isBestAvailableEnabled,
      bestAvailablePriority: s.bestAvailablePriority,
      showNameOnMap: s.showNameOnMap,
      showLabelOnTicket: s.showLabelOnTicket,
    })),
    rows: rows
      .filter((r) => activeSections.has(r.sectionId))
      .map((r) => ({
        id: r.id,
        sectionId: r.sectionId,
        label: r.label,
        sortOrder: r.sortOrder,
        geometry: r.geometry,
      })),
    elements: elements.map((e) => ({
      id: e.id,
      type: e.type,
      label: e.label,
      geometry: e.geometry,
      style: e.style,
      zIndex: e.zIndex,
    })),
    entrances: entrances.map((e) => ({ id: e.id, name: e.name, code: e.code, x: e.x, y: e.y })),
    seats: seatRows
      .filter((s) => activeSections.has(s.sectionId))
      .map((s) => ({
        ...(partners.has(s.id) ? { w: partners.get(s.id) } : {}),
        i: s.id,
        s: s.sectionId,
        r: s.rowId,
        t: s.tableElementId,
        l: s.label,
        p: s.position,
        x: s.x,
        y: s.y,
        o: s.rotation,
        c: s.priceCategoryId && categoryById.has(s.priceCategoryId) ? s.priceCategoryId : null,
        k: s.bestAvailableRank,
        f:
          (s.isWheelchairSpace ? SEAT_FLAG.WHEELCHAIR : 0) |
          (s.isCompanionSeat ? SEAT_FLAG.COMPANION : 0) |
          (s.hasRestrictedView ? SEAT_FLAG.RESTRICTED_VIEW : 0) |
          (s.blockReason ? SEAT_FLAG.BLOCKED : 0),
        m: s.symbolId,
      })),
    symbols: await symbolsByIds(db, [
      ...seatRows.map((s) => s.symbolId).filter((id): id is string => !!id),
      ...elements.map((e) => e.style.symbolId).filter((id): id is string => !!id),
      ...(map.settings.defaultSeatSymbolId ? [map.settings.defaultSeatSymbolId] : []),
    ]),
  };
}
