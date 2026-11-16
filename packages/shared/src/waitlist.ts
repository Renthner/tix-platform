import type { WaitlistTrigger } from './enums';
import { SEAT_FLAG, type PublicSeatMap } from './seating/public';

/**
 * Availability state of the waiting-list banner. One pure implementation is shared by the server
 * (event page render, worker matching) and the browser (live banner from the seat deltas), so both
 * always agree.
 */

/** Live inventory as the shop sees it. */
export interface WaitlistInventory {
  /** Sold / reserved seats. */
  taken: ReadonlySet<string>;
  /** Seats held in any cart (other visitors and the own cart). */
  held: ReadonlySet<string>;
  /** Remaining standing spots per section (capacity − sold − held in carts). */
  ga: Readonly<Record<string, number>>;
  /** Sellable standing spots per section (capacity − sold, holds not subtracted); absent = unknown. */
  gaOpen?: Readonly<Record<string, number>>;
}

export interface WaitlistCategoryState {
  id: string;
  /** Tickets that exist at all (sold or not, not blocked); 0 = nothing is sold in this category. */
  capacity: number;
  /** Tickets that can be selected right now. */
  free: number;
  /** Tickets held in carts (neither free nor sold): they may come back. */
  held: number;
}

type MapLike = Pick<PublicSeatMap, 'categories' | 'seats' | 'sections'>;

/** Per-category ticket counts of an event. */
export function computeWaitlistCategoryStates(
  map: MapLike,
  inventory: WaitlistInventory,
): WaitlistCategoryState[] {
  const states = new Map<string, WaitlistCategoryState>(
    map.categories.map((c) => [c.id, { id: c.id, capacity: 0, free: 0, held: 0 }]),
  );
  for (const seat of map.seats) {
    if ((seat.f & SEAT_FLAG.BLOCKED) !== 0) continue;
    const state = seat.c === null ? undefined : states.get(seat.c);
    if (!state) continue;
    state.capacity += 1;
    if (inventory.taken.has(seat.i)) continue;
    if (inventory.held.has(seat.i)) state.held += 1;
    else state.free += 1;
  }
  for (const section of map.sections) {
    if (section.type !== 'STANDING') continue;
    const state =
      section.priceCategoryId === null ? undefined : states.get(section.priceCategoryId);
    if (!state) continue;
    const free = Math.max(0, inventory.ga[section.id] ?? 0);
    const open = Math.max(free, inventory.gaOpen?.[section.id] ?? free);
    // A standing area that is sold out still counts as offered.
    state.capacity += Math.max(1, open);
    state.free += free;
    state.held += open - free;
  }
  return [...states.values()];
}

export interface WaitlistDecision {
  /** Nothing at all is available: the whole event is out. */
  soldOut: boolean;
  /** Categories to offer (with tickets once, but none left under the trigger). */
  categoryIds: string[];
}

/**
 * Whether and for what the banner is offered. WHEN_UNAVAILABLE: a category is out as soon as no
 * ticket can be selected now. WHEN_SOLD_OUT: only when additionally no ticket is merely held in a
 * cart (held tickets may return to the pool, buyers should not give up).
 */
export function decideWaitlistOffer(
  states: readonly WaitlistCategoryState[],
  trigger: WaitlistTrigger,
): WaitlistDecision | null {
  const strict = trigger === 'WHEN_SOLD_OUT';
  const isOut = (s: Pick<WaitlistCategoryState, 'free' | 'held'>) =>
    s.free === 0 && (!strict || s.held === 0);
  const categoryIds = states.filter((s) => s.capacity > 0 && isOut(s)).map((s) => s.id);
  const soldOut = isOut({
    free: states.reduce((sum, s) => sum + s.free, 0),
    held: states.reduce((sum, s) => sum + s.held, 0),
  });
  if (!soldOut && categoryIds.length === 0) return null;
  return { soldOut, categoryIds };
}
