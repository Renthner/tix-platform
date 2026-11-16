import { computeWaitlistCategoryStates, type WaitlistCategoryState } from '@tix/shared';
import { getAvailability } from '../cart';
import type { CoreContext } from '../context';
import type { EventRow } from '../events';
import { getPublicSeatMap } from '../seatmaps/public';

/** Tickets per price category, from the seat map and the live inventory. */
export interface WaitlistAvailability {
  /** Tickets that can be selected right now (not sold, not blocked, not held in a cart). */
  total: number;
  /** Per price category id (categories without a free ticket are present with 0). */
  byCategory: Record<string, number>;
  /** Tickets per category that exist at all (sold or not); 0 = nothing is sold in this category. */
  capacityByCategory: Record<string, number>;
  /** Tickets held in carts per category (neither free nor sold: they may come back). */
  heldByCategory: Record<string, number>;
}

export const EMPTY_WAITLIST_AVAILABILITY: WaitlistAvailability = {
  total: 0,
  byCategory: {},
  capacityByCategory: {},
  heldByCategory: {},
};

/** Counts per category from the seat map and the live inventory (see the shared computation). */
export function waitlistAvailabilityFromStates(
  states: readonly WaitlistCategoryState[],
): WaitlistAvailability {
  const byId = (pick: (s: WaitlistCategoryState) => number) =>
    Object.fromEntries(states.map((s) => [s.id, pick(s)]));
  return {
    total: states.reduce((sum, s) => sum + s.free, 0),
    byCategory: byId((s) => s.free),
    capacityByCategory: byId((s) => s.capacity),
    heldByCategory: byId((s) => s.held),
  };
}

/** Category states of an event right now (the banner decision and the matching use them). */
export async function getWaitlistCategoryStates(
  ctx: CoreContext,
  event: EventRow,
): Promise<WaitlistCategoryState[]> {
  const [map, availability] = await Promise.all([
    getPublicSeatMap(ctx, event),
    getAvailability(ctx, null, event),
  ]);
  return computeWaitlistCategoryStates(map, {
    taken: new Set(availability.taken),
    held: new Set(availability.locked),
    ga: availability.ga,
    gaOpen: availability.gaOpen,
  });
}

/**
 * Free tickets per price category and in total. Seats held in other carts do not count: they are
 * not buyable at this moment, and their return to the pool is a real "tickets are available
 * again" event (so notifications ignore the banner trigger on purpose).
 */
export async function getWaitlistAvailability(
  ctx: CoreContext,
  event: EventRow,
): Promise<WaitlistAvailability> {
  return waitlistAvailabilityFromStates(await getWaitlistCategoryStates(ctx, event));
}

export interface WaitlistWish {
  /** Wanted category; null = any. */
  categoryId: string | null;
  quantity: number;
}

/**
 * Whether the availability satisfies a waiting-list entry: enough tickets in its category, or for
 * "any category" enough tickets in at least one category.
 */
export function matchesAvailability(
  wish: WaitlistWish,
  availability: WaitlistAvailability,
): boolean {
  const free =
    wish.categoryId === null
      ? Math.max(0, ...Object.values(availability.byCategory))
      : (availability.byCategory[wish.categoryId] ?? 0);
  return free >= Math.max(1, wish.quantity);
}
