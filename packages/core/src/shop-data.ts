import { events, mediaAssets, priceCategories, queueAnnouncements, venues } from '@tix/db';
import type { PublicSymbol, Translations } from '@tix/shared';
import { and, desc, eq, gt, inArray, isNull, min, or, sql } from 'drizzle-orm';
import { SHOP_TAGS, shopCache } from './cache/shop-cache';
import type { CoreContext } from './context';
import {
  effectiveQueueConfig,
  type EffectiveQueueConfig,
  type EventRow,
  type VenueRow,
} from './events';
import { getMediaAsset, type MediaAssetRow } from './media';
import { symbolsByIds } from './symbols';

/**
 * Cached read models of the public shop pages (home, event page). Everything here is identical
 * for every visitor and changes only through admin actions, which invalidate the tags below
 * (see cache/shop-cache.ts). Nothing time dependent is evaluated at load time: sale state,
 * announcement expiry and "event already started" are decided by the caller at render time from
 * the cached timestamps.
 */

const SAFETY_TTL_MS = 60_000;

/** Event page data of one slug (event row, venue, cover, info box symbols). */
export interface ShopEventBundle {
  event: EventRow;
  venue: VenueRow;
  cover: MediaAssetRow | null;
  /** Symbols used by the info boxes, by id. */
  symbols: Record<string, PublicSymbol>;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Published / postponed event by slug with everything the event page needs besides live data.
 * Unknown, unpublished and malformed slugs return null (never cached: a new event must appear
 * at once and random URLs must not evict real entries).
 */
export async function getShopEventBySlug(
  ctx: Pick<CoreContext, 'db'>,
  slug: string,
): Promise<ShopEventBundle | null> {
  if (!SLUG.test(slug)) return null;
  return shopCache.get<ShopEventBundle | null>(
    `shop-event:${slug}`,
    async () => {
      const [row] = await ctx.db
        .select({ event: events, venue: venues })
        .from(events)
        .innerJoin(venues, eq(venues.id, events.venueId))
        .where(eq(events.slug, slug));
      if (!row || (row.event.status !== 'PUBLISHED' && row.event.status !== 'POSTPONED')) {
        return null;
      }
      return buildShopEventBundle(ctx, row);
    },
    {
      tags: (bundle) => [
        SHOP_TAGS.events,
        SHOP_TAGS.venues,
        SHOP_TAGS.media,
        SHOP_TAGS.symbols,
        ...(bundle ? [SHOP_TAGS.event(bundle.event.id)] : []),
      ],
      ttlMs: (bundle) => (bundle ? SAFETY_TTL_MS : 0),
    },
  );
}

async function buildShopEventBundle(
  ctx: Pick<CoreContext, 'db'>,
  row: { event: EventRow; venue: VenueRow },
): Promise<ShopEventBundle> {
  const [coverRows, symbolList] = await Promise.all([
    row.event.heroImageAssetId
      ? ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, row.event.heroImageAssetId))
      : Promise.resolve([]),
    symbolsByIds(
      ctx.db,
      row.event.infoBoxes.flatMap((b) => (b.symbolId ? [b.symbolId] : [])),
    ),
  ]);
  return {
    event: row.event,
    venue: row.venue,
    cover: coverRows[0] ?? null,
    symbols: Object.fromEntries(symbolList.map((s) => [s.id, s])),
  };
}

/**
 * DRAFT event by slug for super-admins (test purchases). NEVER cached: draft data must not enter
 * the public shop cache, whose keys any visitor can reach. The caller must have verified the
 * super-admin role on this request; only DRAFT rows are returned (published events use
 * `getShopEventBySlug`).
 */
export async function getDraftEventBySlug(
  ctx: Pick<CoreContext, 'db'>,
  slug: string,
): Promise<ShopEventBundle | null> {
  if (!SLUG.test(slug)) return null;
  const [row] = await ctx.db
    .select({ event: events, venue: venues })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(and(eq(events.slug, slug), eq(events.status, 'DRAFT')));
  return row ? buildShopEventBundle(ctx, row) : null;
}

/** Media asset row (logo, cover) from the shop data cache; replaced / deleted assets invalidate `media`. */
export function getShopMediaAsset(ctx: CoreContext, id: string): Promise<MediaAssetRow | null> {
  return shopCache.get(`shop-media:${id}`, () => getMediaAsset(ctx, id), {
    tags: [SHOP_TAGS.media],
    ttlMs: (asset) => (asset ? SAFETY_TTL_MS : 0),
  });
}

/** Queue settings the event page shows (texts, batch size); live access checks never use this. */
export function getShopQueueConfig(
  ctx: Pick<CoreContext, 'db'>,
  eventId: string,
): Promise<EffectiveQueueConfig> {
  return shopCache.get(`shop-queue:${eventId}`, () => effectiveQueueConfig(ctx, eventId), {
    tags: [SHOP_TAGS.queue, SHOP_TAGS.event(eventId)],
    ttlMs: SAFETY_TTL_MS,
  });
}

export interface ShopAnnouncement {
  id: string;
  message: string;
  translations: Translations;
  severity: (typeof queueAnnouncements.$inferSelect)['severity'];
  publishedAt: Date;
  expiresAt: Date | null;
}

const ANNOUNCEMENT_LIMIT = 5;

/**
 * Current organiser announcements of an event (event specific + global), newest first. The
 * cached list keeps a few more than shown and is filtered by `expiresAt` on every read, so an
 * announcement that expires disappears without waiting for the cache.
 */
export async function getShopAnnouncements(
  ctx: Pick<CoreContext, 'db'>,
  eventId: string,
  now = new Date(),
): Promise<ShopAnnouncement[]> {
  const rows = await shopCache.get<ShopAnnouncement[]>(
    `shop-announcements:${eventId}`,
    () =>
      ctx.db
        .select({
          id: queueAnnouncements.id,
          message: queueAnnouncements.message,
          translations: queueAnnouncements.translations,
          severity: queueAnnouncements.severity,
          publishedAt: queueAnnouncements.publishedAt,
          expiresAt: queueAnnouncements.expiresAt,
        })
        .from(queueAnnouncements)
        .where(
          and(
            or(eq(queueAnnouncements.eventId, eventId), isNull(queueAnnouncements.eventId)),
            or(isNull(queueAnnouncements.expiresAt), gt(queueAnnouncements.expiresAt, sql`now()`)),
          ),
        )
        .orderBy(desc(queueAnnouncements.publishedAt))
        .limit(ANNOUNCEMENT_LIMIT * 4),
    { tags: [SHOP_TAGS.queue, SHOP_TAGS.event(eventId)], ttlMs: SAFETY_TTL_MS },
  );
  return rows.filter((a) => !a.expiresAt || a.expiresAt > now).slice(0, ANNOUNCEMENT_LIMIT);
}

export interface ShopListEvent {
  event: EventRow;
  venue: Pick<VenueRow, 'name' | 'city' | 'translations'>;
  cover: { id: string; width: number | null; height: number | null } | null;
  /** Lowest base price of the active price categories (cents), null = none. */
  fromPrice: number | null;
}

const LIST_LIMIT = 100;

/**
 * Events of the shop home: published / postponed, in the admin's manual order, then by start.
 * The cache holds the events that had not started when it was loaded and expires exactly when
 * the first of them starts; callers still drop events that started in between (`startsAt`).
 */
export async function getShopEventList(ctx: Pick<CoreContext, 'db'>): Promise<ShopListEvent[]> {
  const list = await shopCache.get<ShopListEvent[]>(
    'shop-list',
    async () => {
      const rows = await ctx.db
        .select({
          event: events,
          venue: { name: venues.name, city: venues.city, translations: venues.translations },
          cover: { id: mediaAssets.id, width: mediaAssets.width, height: mediaAssets.height },
        })
        .from(events)
        .innerJoin(venues, eq(venues.id, events.venueId))
        .leftJoin(mediaAssets, eq(mediaAssets.id, events.heroImageAssetId))
        .where(
          and(inArray(events.status, ['PUBLISHED', 'POSTPONED']), gt(events.startsAt, sql`now()`)),
        )
        .orderBy(
          sql`${events.shopSortOrder} ASC NULLS LAST`,
          sql`${events.startsAt} ASC`,
          sql`${events.id} ASC`,
        )
        .limit(LIST_LIMIT);
      const prices = rows.length
        ? await ctx.db
            .select({ eventId: priceCategories.eventId, from: min(priceCategories.basePrice) })
            .from(priceCategories)
            .where(
              and(
                inArray(
                  priceCategories.eventId,
                  rows.map((r) => r.event.id),
                ),
                eq(priceCategories.isActive, true),
              ),
            )
            .groupBy(priceCategories.eventId)
        : [];
      const from = new Map(prices.map((p) => [p.eventId, p.from]));
      return rows.map((r): ShopListEvent => ({
        event: r.event,
        venue: r.venue,
        cover: r.cover?.id ? r.cover : null,
        fromPrice: from.get(r.event.id) ?? null,
      }));
    },
    {
      tags: (rows) => [
        SHOP_TAGS.events,
        SHOP_TAGS.venues,
        SHOP_TAGS.media,
        ...rows.map((r) => SHOP_TAGS.event(r.event.id)),
      ],
      ttlMs: (rows) => {
        const first = Math.min(...rows.map((r) => r.event.startsAt.getTime()));
        return Math.min(SAFETY_TTL_MS, Number.isFinite(first) ? first - Date.now() : SAFETY_TTL_MS);
      },
    },
  );
  const now = new Date();
  return list.filter((r) => r.event.startsAt > now);
}
