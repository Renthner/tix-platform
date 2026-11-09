import { events, orderItems } from '@tix/db';
import { asc, sql } from 'drizzle-orm';

/**
 * Canonical order of the tickets/items of an order: event start, block, row, seat, then item id as
 * a stable tie-breaker. Used by the order page, PDF pages, wallet buttons and ticket lists so
 * customers always see the same sequence. Requires `events` and `order_items` in the query.
 */
export const placeOrderBy = () => [
  asc(events.startsAt),
  asc(orderItems.sectionLabel),
  asc(orderItems.rowLabel),
  // natural seat order ("9" before "10"); non-numeric labels last, then alphabetical
  sql`nullif(regexp_replace(${orderItems.seatLabel}, '[^0-9]', '', 'g'), '')::numeric asc nulls last`,
  asc(orderItems.seatLabel),
  asc(orderItems.id),
];
