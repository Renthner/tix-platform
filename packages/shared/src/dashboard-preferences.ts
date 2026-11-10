import { z } from 'zod';
import { EVENT_STATUSES, type EventStatus } from './enums';

/** Status filter of the dashboard until an admin picks their own. */
export const DEFAULT_DASHBOARD_STATUSES: EventStatus[] = ['PUBLISHED', 'POSTPONED'];

/** Event cards shown at most (the overview always covers every matching event). */
export const MAX_DASHBOARD_CARDS = 60;

/** Remembered card order is capped; the oldest (last) entries fall off. */
export const MAX_DASHBOARD_ORDER_IDS = 500;

const statusFilterSchema = z
  .array(z.enum(EVENT_STATUSES))
  .min(1)
  .refine((s) => new Set(s).size === s.length, 'invalid');

const orderSchema = z
  .array(z.uuid())
  .max(MAX_DASHBOARD_ORDER_IDS)
  .refine((ids) => new Set(ids).size === ids.length, 'invalid');

/** Input of "save my dashboard settings": every key optional, only given keys are changed. */
export const dashboardPreferencesInputSchema = z
  .object({ eventOrder: orderSchema, statusFilter: statusFilterSchema })
  .partial()
  .strict();
export type DashboardPreferencesInput = z.infer<typeof dashboardPreferencesInputSchema>;

export interface DashboardPreferences {
  /** Event ids in the order the admin arranged the cards (unknown / removed ids are ignored). */
  eventOrder: string[];
  statusFilter: EventStatus[];
}

/** Reads the stored jsonb leniently: every invalid part falls back to its default. */
export function parseDashboardPreferences(raw: unknown): DashboardPreferences {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const order = orderSchema.safeParse(obj.eventOrder);
  const filter = statusFilterSchema.safeParse(obj.statusFilter);
  return {
    eventOrder: order.success ? order.data : [],
    statusFilter: filter.success ? filter.data : [...DEFAULT_DASHBOARD_STATUSES],
  };
}

/**
 * Sorts by the saved order: listed ids first (in that order), everything else (new events)
 * after them in its incoming order. Ids not present in `items` are ignored.
 */
export function sortByEventOrder<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = items
    .filter((i) => rank.has(i.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...known, ...items.filter((i) => !rank.has(i.id))];
}

/**
 * New saved order after the visible cards were rearranged: the slots the visible cards held in
 * the previous full order are refilled with their new sequence (hidden events keep their slots);
 * visible cards that were not listed yet are appended.
 */
export function applyVisibleOrder(
  previous: readonly string[],
  visible: readonly string[],
): string[] {
  const shown = new Set(visible);
  const queue = [...visible];
  const out: string[] = [];
  for (const id of previous) {
    if (shown.has(id)) {
      const next = queue.shift();
      if (next !== undefined) out.push(next);
    } else out.push(id);
  }
  out.push(...queue);
  return out.slice(0, MAX_DASHBOARD_ORDER_IDS);
}
