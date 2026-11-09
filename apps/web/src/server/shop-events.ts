import 'server-only';
import { events } from '@tix/db';
import { and, gt, inArray, sql } from 'drizzle-orm';

/** Events listed on the shop home: published/postponed and not yet started. */
export const shopVisibleCondition = () =>
  and(inArray(events.status, ['PUBLISHED', 'POSTPONED']), gt(events.startsAt, new Date()));

/** Manual order first, then events without one by start date (mirrors `sortShopEvents`). */
export const shopOrderBy = () => [
  sql`${events.shopSortOrder} ASC NULLS LAST`,
  sql`${events.startsAt} ASC`,
  sql`${events.id} ASC`,
];
