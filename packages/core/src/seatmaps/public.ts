import {
  events,
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
  localizePublicSeatMap,
  SEAT_FLAG,
  companionPartners,
  computeTicketPrice,
  type PublicSeatMap,
  type PublicTicketType,
  type SalesChannel,
} from '@tix/shared';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { SHOP_TAGS, shopCache } from '../cache/shop-cache';
import { DomainError, type CoreContext } from '../context';
import { contentLocale } from '../content-locale';
import type { EventRow } from '../events';
import { symbolsByIds } from '../symbols';

/**
 * Public seating plan of an event (no availability). Cached in Redis per snapshot stamp (shared
 * by all processes) and in the process-wide shop data cache (tag invalidated, see
 * cache/shop-cache.ts), so 1,000+ simultaneous page loads cost one build.
 *
 * The stamp = (seat map version, event public map generation). The version changes on every plan
 * save, the generation (database triggers, same transaction) on every change of categories,
 * tariffs, the pricing matrix or the currency. Both are part of every cache key, so a snapshot
 * built before a committed change is never looked up again: correctness does not depend on the
 * post-commit invalidation (which only frees memory and makes other processes notice quickly).
 */

/** Safety TTL of the cached version (invalidation normally makes a save visible at once). */
const VERSION_TTL_MS = 1_000;
const versionTags = (seatMapId: string) => [
  SHOP_TAGS.events,
  SHOP_TAGS.symbols,
  `seatmap:${seatMapId}`,
];

/**
 * Current seat map version (shop data cache, 1 s safety TTL). A plan save invalidates the event
 * tags on every instance, which drops the cached version as well.
 */
export function seatMapVersion(ctx: Pick<CoreContext, 'db'>, seatMapId: string): Promise<number> {
  return shopCache.get(
    `seatmap-version:${seatMapId}`,
    async () => {
      const [row] = await ctx.db
        .select({ version: seatMaps.version })
        .from(seatMaps)
        .where(eq(seatMaps.id, seatMapId));
      if (!row) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Seat map not found', 404);
      return row.version;
    },
    { tags: versionTags(seatMapId), ttlMs: VERSION_TTL_MS },
  );
}

/** Forgets the cached version in this process (call right after saving a seat map). */
export function forgetSeatMapVersion(seatMapId: string): void {
  shopCache.invalidate([`seatmap:${seatMapId}`]);
}

interface MapStamp {
  seatMapId: string;
  version: number;
  generation: number;
  /** Part of the map but read with the stamp (the passed event row may come from a cache). */
  currency: string;
}

/** Stamp straight from the database (one indexed lookup, always current). */
async function readStamp(ctx: Pick<CoreContext, 'db'>, event: EventRow): Promise<MapStamp> {
  const [row] = await ctx.db
    .select({
      seatMapId: seatMaps.id,
      version: seatMaps.version,
      generation: events.publicMapGeneration,
      currency: events.currency,
    })
    .from(events)
    .innerJoin(seatMaps, eq(seatMaps.id, events.seatMapId))
    .where(eq(events.id, event.id));
  if (!row) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  return row;
}

/**
 * Stamp for display paths: cached for at most ~1 s (and dropped by the tag invalidation of a
 * change). Money paths pass `fresh` and read the database.
 */
function publicMapStamp(ctx: CoreContext, event: EventRow, fresh: boolean): Promise<MapStamp> {
  if (fresh) return readStamp(ctx, event);
  return shopCache.get(`pubmap-stamp:${event.id}`, () => readStamp(ctx, event), {
    tags: [...versionTags(event.seatMapId ?? ''), SHOP_TAGS.event(event.id)],
    ttlMs: VERSION_TTL_MS,
  });
}

const stampKey = (s: MapStamp) => `${s.seatMapId}.${s.version}.g${s.generation}`;
const sameStamp = (a: MapStamp, b: MapStamp) =>
  a.seatMapId === b.seatMapId && a.version === b.version && a.generation === b.generation;

/** Attempts to build a map that was not changed by a commit while it was being read. */
const BUILD_ATTEMPTS = 3;

interface BuiltMap {
  map: PublicSeatMap;
  /** False when the data changed during every build attempt (map may mix generations). */
  consistent: boolean;
}

/** Process cache lifetime of a consistent map (the cache default). */
const DEFAULT_PLAN_TTL_MS = 60_000;

export interface PublicSeatMapOptions {
  /**
   * Read the stamp from the database instead of the ~1 s process cache. Required by everything
   * that prices a cart / order (checkout, quote, box office); display paths may omit it.
   */
  fresh?: boolean;
}

export async function getPublicSeatMap(
  ctx: CoreContext,
  event: EventRow,
  options: PublicSeatMapOptions = {},
): Promise<PublicSeatMap> {
  if (!event.seatMapId) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  const fresh = options.fresh === true;
  const stamp = await publicMapStamp(ctx, event, fresh);
  const built = await shopCache.get(
    `pubmap:${event.id}:${stampKey(stamp)}:${PUBLIC_MAP_FORMAT}`,
    async (): Promise<BuiltMap> => {
      const redisKey = ctx.keys.seatMapSnapshot(
        event.id,
        stamp.version,
        stamp.generation,
        PUBLIC_MAP_FORMAT,
      );
      const cached = await ctx.redis.get(redisKey);
      if (cached) return { map: JSON.parse(cached) as PublicSeatMap, consistent: true };
      // The stamp was read before the data, so the data is at least as new as the key. A commit
      // during the build makes it newer, or mixed across the separate queries; the stamp re-read
      // then differs and such a map is neither stored under the old key nor trusted (rebuilt).
      let current = stamp;
      let map = await buildPublicSeatMap(ctx, event, current);
      for (let attempt = 1; ; attempt++) {
        const after = await readStamp(ctx, event);
        if (sameStamp(after, current)) {
          const key = ctx.keys.seatMapSnapshot(
            event.id,
            current.version,
            current.generation,
            PUBLIC_MAP_FORMAT,
          );
          await ctx.redis.set(key, JSON.stringify(map), 'EX', 3600);
          return { map, consistent: true };
        }
        // Out of attempts: the map may mix generations, so it is not stored anywhere.
        if (attempt >= BUILD_ATTEMPTS) return { map, consistent: false };
        current = after;
        map = await buildPublicSeatMap(ctx, event, current);
      }
    },
    { tags: planTags(event.id), ttlMs: (value) => (value.consistent ? DEFAULT_PLAN_TTL_MS : 0) },
  );
  // Money paths never price from a possibly mixed map (retryable); display paths may show the
  // newest build, which the next request replaces.
  if (!built.consistent && fresh) {
    throw new DomainError('PRICES_UPDATING', 'Prices are being updated, please retry', 503);
  }
  return built.map;
}

/** Tags of a cached plan: its event (prices, tariffs, categories) and the symbol library. */
const planTags = (eventId: string) => [SHOP_TAGS.event(eventId), SHOP_TAGS.symbols];

/** Public plan with all content translations resolved for `locale` (shop API, documents). */
export async function getLocalizedPublicSeatMap(
  ctx: CoreContext,
  event: EventRow,
  locale?: string | null,
): Promise<PublicSeatMap> {
  const { locale: loc, defaultLocale } = await contentLocale(ctx, locale);
  return localizePublicSeatMap(await getPublicSeatMap(ctx, event), loc, defaultLocale);
}

/** Serialised localized plan plus a content hash for HTTP revalidation (ETag). */
export interface PublicSeatMapPayload {
  json: string;
  etag: string;
}

/**
 * Localized public plan as ready-to-send JSON with a strong ETag (content hash). Built once per
 * (event, plan stamp, locale) and shared by all requests until a tag invalidation (price or
 * tariff change, plan save, symbol change, event delete) drops it. `loc` is always a supported
 * locale (contentLocale), so the key space is bounded.
 */
export async function getPublicSeatMapPayload(
  ctx: CoreContext,
  event: EventRow,
  locale?: string | null,
): Promise<PublicSeatMapPayload> {
  if (!event.seatMapId) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  const stamp = await publicMapStamp(ctx, event, false);
  const { locale: loc, defaultLocale } = await contentLocale(ctx, locale);
  return shopCache.get(
    `pubmap-json:${event.id}:${stampKey(stamp)}:${PUBLIC_MAP_FORMAT}:${loc}:${defaultLocale}`,
    async () => {
      const map = localizePublicSeatMap(await getPublicSeatMap(ctx, event), loc, defaultLocale);
      const json = JSON.stringify(map);
      return { json, etag: `"${createHash('sha1').update(json).digest('base64url')}"` };
    },
    { tags: planTags(event.id) },
  );
}

/**
 * Tariffs sellable in a sales channel with their price per category (matrix applied).
 * Shared by the public (ONLINE) map and the box office (BOX_OFFICE / ADMIN).
 */
async function buildTicketTypeList(
  db: CoreContext['db'],
  types: (typeof ticketTypes.$inferSelect)[],
  categories: { id: string; basePrice: number }[],
  channel: SalesChannel,
): Promise<PublicTicketType[]> {
  const channelTypes = types.filter((t) => t.channels.includes(channel));
  const matrix = channelTypes.length
    ? await db
        .select()
        .from(priceCategoryTicketTypes)
        .where(
          and(
            inArray(
              priceCategoryTicketTypes.ticketTypeId,
              channelTypes.map((t) => t.id),
            ),
            eq(priceCategoryTicketTypes.isActive, true),
          ),
        )
    : [];

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  return channelTypes.map((t) => {
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
      tr: t.translations,
      prices,
    };
  });
}

/**
 * Seating plan with the tariffs of another sales channel (box office). Not cached: used by
 * the few admin users at the door, the (cached) public map supplies everything else.
 */
export async function getSeatMapForChannel(
  ctx: CoreContext,
  event: EventRow,
  channel: SalesChannel,
): Promise<PublicSeatMap> {
  const map = await getPublicSeatMap(ctx, event, { fresh: true });
  if (channel === 'ONLINE') return map;
  const types = await ctx.db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.eventId, event.id), eq(ticketTypes.isActive, true)))
    .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.name));
  return { ...map, ticketTypes: await buildTicketTypeList(ctx.db, types, map.categories, channel) };
}

async function buildPublicSeatMap(
  ctx: CoreContext,
  event: EventRow,
  stamp: MapStamp,
): Promise<PublicSeatMap> {
  const db = ctx.db;
  const { seatMapId, version } = stamp;
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

  const ticketTypeList = await buildTicketTypeList(db, types, categories, 'ONLINE');

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const activeSections = new Set(sections.map((s) => s.id));
  return {
    eventId: event.id,
    version,
    canvasWidth: map.canvasWidth,
    canvasHeight: map.canvasHeight,
    settings: map.settings,
    backgroundUrl: null,
    currency: stamp.currency,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      basePrice: c.basePrice,
      sortOrder: c.sortOrder,
      maxPerOrder: c.maxTicketsPerOrder,
      tr: c.translations,
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
      tr: s.translations,
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
      tr: e.translations,
    })),
    entrances: entrances.map((e) => ({
      id: e.id,
      name: e.name,
      code: e.code,
      x: e.x,
      y: e.y,
      tr: e.translations,
    })),
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
