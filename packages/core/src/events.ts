import { events, queueConfigs, venues } from '@tix/db';
import type { QueueAdmissionOrder, QueueMode, Translations } from '@tix/shared';
import { and, eq, isNull, or } from 'drizzle-orm';
import { DomainError, type CoreContext } from './context';
import { SHOP_TAGS, shopCache } from './cache/shop-cache';
import { getSetting } from './settings';

export type EventRow = typeof events.$inferSelect;
export type VenueRow = typeof venues.$inferSelect;

/**
 * NOT_PUBLISHED / CANCELLED – not sellable at all
 * NOT_STARTED  – published, sale has not started (countdown)
 * PRESALE      – only holders of an access code with presale permission
 * ON_SALE      – public sale
 * PAUSED       – emergency stop by an admin
 * ENDED        – sale window closed / event started
 */
export type SaleState =
  'NOT_PUBLISHED' | 'CANCELLED' | 'NOT_STARTED' | 'PRESALE' | 'ON_SALE' | 'PAUSED' | 'ENDED';

export function computeSaleState(event: EventRow, now = new Date()): SaleState {
  if (event.status === 'CANCELLED') return 'CANCELLED';
  if (event.status !== 'PUBLISHED' && event.status !== 'POSTPONED') return 'NOT_PUBLISHED';
  const end = event.saleEndsAt ?? event.startsAt;
  if (now >= end) return 'ENDED';
  if (event.salesPaused) return 'PAUSED';
  if (event.publicSaleStartsAt && now < event.publicSaleStartsAt) {
    if (event.presaleStartsAt && now >= event.presaleStartsAt) return 'PRESALE';
    return 'NOT_STARTED';
  }
  if (!event.publicSaleStartsAt && event.presaleStartsAt && now < event.presaleStartsAt) {
    return 'NOT_STARTED';
  }
  return 'ON_SALE';
}

/** Moment the public sale opens (T-0 of the waiting room), if scheduled. */
export function saleOpensAt(event: EventRow): Date | null {
  return event.publicSaleStartsAt ?? event.presaleStartsAt ?? null;
}

/** Effective checkout rules: event override ?? global `checkout` setting. */
export interface EffectiveCheckoutConfig {
  cartLockTtlSeconds: number;
  paymentGraceSeconds: number;
  /** Null = unlimited. */
  maxTicketsPerOrder: number | null;
  maxTicketsPerCustomer: number | null;
  manualSeatSelectionEnabled: boolean;
  bestAvailableEnabled: boolean;
  orphanSeatRuleEnabled: boolean;
  /** Companion seats only together with their wheelchair space. */
  companionRequiresWheelchair: boolean;
}

export async function effectiveCheckoutConfig(
  ctx: Pick<CoreContext, 'db'>,
  event: EventRow,
): Promise<EffectiveCheckoutConfig> {
  const global = await getSetting(ctx, 'checkout');
  return {
    cartLockTtlSeconds: event.cartLockTtlSeconds ?? global.cartLockTtlSeconds,
    paymentGraceSeconds: event.paymentGraceSeconds ?? global.paymentGraceSeconds,
    maxTicketsPerOrder: event.maxTicketsPerOrder ?? global.maxTicketsPerOrder,
    maxTicketsPerCustomer: event.maxTicketsPerCustomer ?? global.maxTicketsPerCustomer,
    manualSeatSelectionEnabled:
      event.manualSeatSelectionEnabled ?? global.manualSeatSelectionEnabled,
    bestAvailableEnabled: event.bestAvailableEnabled ?? global.bestAvailableEnabled,
    orphanSeatRuleEnabled: event.orphanSeatRuleEnabled ?? global.orphanSeatRuleEnabled,
    companionRequiresWheelchair:
      event.companionRequiresWheelchair ?? global.companionSeatsRequireWheelchair,
  };
}

export interface EffectiveQueueConfig {
  source: 'EVENT' | 'GLOBAL' | 'DEFAULT';
  mode: QueueMode;
  activeSessionThreshold: number;
  admissionBatchSize: number;
  admissionIntervalSeconds: number;
  passTokenTtlSeconds: number;
  lobbyOpensMinutesBefore: number;
  admissionOrder: QueueAdmissionOrder;
  accessCodeBypassesQueue: boolean;
  maxQueueSize: number | null;
  isPaused: boolean;
  title: string | null;
  message: string | null;
  /** Translations of `title` / `message` (resolve with `localized`). */
  translations: Translations;
}

/** Shoppers without heartbeat for this long stop counting as active. */
export const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

export async function effectiveQueueConfig(
  ctx: Pick<CoreContext, 'db'>,
  eventId: string,
): Promise<EffectiveQueueConfig> {
  const rows = await ctx.db
    .select()
    .from(queueConfigs)
    .where(or(eq(queueConfigs.eventId, eventId), isNull(queueConfigs.eventId)));
  const row = rows.find((r) => r.eventId === eventId) ?? rows.find((r) => r.eventId === null);
  if (!row) {
    return {
      source: 'DEFAULT',
      mode: 'OFF',
      activeSessionThreshold: 250,
      admissionBatchSize: 50,
      admissionIntervalSeconds: 30,
      passTokenTtlSeconds: 900,
      lobbyOpensMinutesBefore: 60,
      admissionOrder: 'RANDOMIZED',
      accessCodeBypassesQueue: true,
      maxQueueSize: null,
      isPaused: false,
      title: null,
      message: null,
      translations: {},
    };
  }
  return {
    source: row.eventId ? 'EVENT' : 'GLOBAL',
    mode: row.mode,
    activeSessionThreshold: row.activeSessionThreshold,
    admissionBatchSize: row.admissionBatchSize,
    admissionIntervalSeconds: row.admissionIntervalSeconds,
    passTokenTtlSeconds: row.passTokenTtlSeconds,
    lobbyOpensMinutesBefore: row.lobbyOpensMinutesBefore,
    admissionOrder: row.admissionOrder,
    accessCodeBypassesQueue: row.accessCodeBypassesQueue,
    maxQueueSize: row.maxQueueSize,
    isPaused: row.isPaused,
    title: row.title,
    message: row.message,
    translations: row.translations,
  };
}

export async function getEventById(
  ctx: Pick<CoreContext, 'db'>,
  eventId: string,
): Promise<EventRow> {
  const [event] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  return event;
}

/** Safety TTL of `getEventCached`; the normal freshness mechanism is tag invalidation. */
const EVENT_CACHE_TTL_MS = 10_000;

/**
 * Event lookup for hot shop paths (seat clicks of 1,000+ concurrent users) from the shop data
 * cache. Event changes (sales pause, dates, status, ...) invalidate the `event:<id>` tag on every
 * web instance within milliseconds; processes without a cache subscription fall back to a few
 * seconds.
 */
export async function getEventCached(
  ctx: Pick<CoreContext, 'db'>,
  eventId: string,
): Promise<EventRow> {
  return shopCache.get(`event-row:${eventId}`, () => getEventById(ctx, eventId), {
    tags: [SHOP_TAGS.event(eventId)],
    ttlMs: EVENT_CACHE_TTL_MS,
  });
}

export async function getEventWithVenueBySlug(
  ctx: Pick<CoreContext, 'db'>,
  slug: string,
): Promise<{ event: EventRow; venue: VenueRow } | null> {
  const [row] = await ctx.db
    .select({ event: events, venue: venues })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(and(eq(events.slug, slug)));
  return row ?? null;
}
