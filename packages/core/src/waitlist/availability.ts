import { SEAT_FLAG } from '@tix/shared';
import { getAvailability } from '../cart';
import type { CoreContext } from '../context';
import type { EventRow } from '../events';
import { getPublicSeatMap } from '../seatmaps/public';

/** Tickets that can be bought right now (not sold, not blocked, not held in a cart). */
export interface WaitlistAvailability {
  total: number;
  /** Per price category id (categories without a free ticket are present with 0). */
  byCategory: Record<string, number>;
  /** Tickets per category that exist at all (sold or not); 0 = nothing is sold in this category. */
  capacityByCategory: Record<string, number>;
}

/**
 * Free tickets per price category and in total, from the seat map and the live inventory.
 * Seats held in other carts do not count: they are not buyable at this moment, and their
 * return to the pool is a real "tickets are available again" event.
 */
export async function getWaitlistAvailability(
  ctx: CoreContext,
  event: EventRow,
): Promise<WaitlistAvailability> {
  const [map, availability] = await Promise.all([
    getPublicSeatMap(ctx, event),
    getAvailability(ctx, null, event),
  ]);
  const unavailable = new Set<string>([...availability.taken, ...availability.locked]);
  const byCategory: Record<string, number> = Object.fromEntries(
    map.categories.map((c) => [c.id, 0]),
  );
  const capacityByCategory: Record<string, number> = { ...byCategory };
  const add = (categoryId: string | null, count: number) => {
    // Without a price category nothing can be sold.
    if (categoryId === null || !(categoryId in byCategory) || count <= 0) return;
    byCategory[categoryId] = (byCategory[categoryId] ?? 0) + count;
  };
  for (const seat of map.seats) {
    if ((seat.f & SEAT_FLAG.BLOCKED) !== 0) continue;
    if (seat.c !== null && seat.c in capacityByCategory) capacityByCategory[seat.c]! += 1;
    if (unavailable.has(seat.i)) continue;
    add(seat.c, 1);
  }
  for (const section of map.sections) {
    if (section.type !== 'STANDING') continue;
    const sectionCategory = section.priceCategoryId;
    if (sectionCategory !== null && sectionCategory in capacityByCategory) {
      // Remaining spots are not the capacity, but a section that is sold out still counts as offered.
      capacityByCategory[sectionCategory]! += Math.max(1, availability.ga[section.id] ?? 0);
    }
    add(section.priceCategoryId, availability.ga[section.id] ?? 0);
  }
  const total = Object.values(byCategory).reduce((sum, n) => sum + n, 0);
  return { total, byCategory, capacityByCategory };
}

export interface WaitlistWish {
  /** Wanted category; null = any. */
  categoryId: string | null;
  quantity: number;
}

/** Whether the availability satisfies a waiting-list entry (enough tickets in its category). */
export function matchesAvailability(
  wish: WaitlistWish,
  availability: WaitlistAvailability,
): boolean {
  const free =
    wish.categoryId === null ? availability.total : (availability.byCategory[wish.categoryId] ?? 0);
  return free >= Math.max(1, wish.quantity);
}
