import { z } from 'zod';

/**
 * Manual order of the events in the shop listing.
 * Rule: events with a sort order first (ascending), then events without one by start date.
 */
export interface ShopSortable {
  id: string;
  startsAt: Date;
  shopSortOrder: number | null;
}

export function compareShopEvents(a: ShopSortable, b: ShopSortable): number {
  if (a.shopSortOrder !== null && b.shopSortOrder !== null && a.shopSortOrder !== b.shopSortOrder)
    return a.shopSortOrder - b.shopSortOrder;
  if (a.shopSortOrder !== null && b.shopSortOrder === null) return -1;
  if (a.shopSortOrder === null && b.shopSortOrder !== null) return 1;
  return a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id);
}

export const sortShopEvents = <T extends ShopSortable>(list: readonly T[]): T[] =>
  [...list].sort(compareShopEvents);

export const MAX_SHOP_ORDER_EVENTS = 200;

/** Submitted order: distinct event ids (JSON array), at most MAX_SHOP_ORDER_EVENTS. */
export const shopOrderInputSchema = z
  .array(z.uuid())
  .max(MAX_SHOP_ORDER_EVENTS)
  .refine((ids) => new Set(ids).size === ids.length, 'invalid');

/** Moves the item at `from` to `to` (returns a new array; out-of-range = unchanged copy). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}
