import { orderItems, seatMapSections, seats } from '@tix/db';
import { INVENTORY_HOLDING_ITEM_STATUSES } from '@tix/shared';
import { QUEUE_NAMES, type TakenCode } from '@tix/redis';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { CoreContext } from './context';
import { DomainError } from './context';
import { getEventById, type EventRow } from './events';
import { coreLog } from './log';
import { publishSeatDelta } from './realtime';
import { forgetSeatMapVersion, seatMapVersion } from './seatmaps/public';

/**
 * Keeps the Redis inventory mirror (taken seats + sellable GA capacity) in sync with
 * PostgreSQL. The mirror is rebuilt whenever it is missing or was built from an older seat
 * map version; order transitions (Phase 3) update single seats incrementally.
 *
 * Safe against cart holds: only `ga:available` (capacity − sold/reserved) and the taken seats are
 * replaced; GA holds (`ga:held` / `ga:holds`) and seat locks are untouched and subtracted at read
 * time. Not atomic against a checkout's post-commit `commitGeneralAdmission` / a release's
 * `releaseGeneralAdmission` (DB commit, then a Redis HINCRBY): a rebuild that reads the DB between
 * the two applies that delta twice – see `scheduleInventoryRebuild`.
 */
export async function rebuildInventory(ctx: CoreContext, event: EventRow): Promise<number> {
  if (!event.seatMapId) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  const version = await seatMapVersion(ctx, event.seatMapId);

  const [seatRows, items, sections] = await Promise.all([
    ctx.db
      .select({ id: seats.id, blockReason: seats.blockReason, removedAt: seats.removedAt })
      .from(seats)
      .where(and(eq(seats.seatMapId, event.seatMapId))),
    ctx.db
      .select({ seatId: orderItems.seatId, status: orderItems.status })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.eventId, event.id),
          isNotNull(orderItems.seatId),
          inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
        ),
      ),
    ctx.db
      .select({
        id: seatMapSections.id,
        capacity: seatMapSections.capacity,
        allocated: seatMapSections.allocatedCount,
      })
      .from(seatMapSections)
      .where(
        and(
          eq(seatMapSections.seatMapId, event.seatMapId),
          eq(seatMapSections.type, 'STANDING'),
          eq(seatMapSections.isActive, true),
          isNull(seatMapSections.removedAt),
        ),
      ),
  ]);

  const taken: Record<string, TakenCode> = {};
  for (const s of seatRows) {
    if (s.removedAt) taken[s.id] = 'X';
    else if (s.blockReason) taken[s.id] = 'B';
  }
  for (const item of items) {
    if (item.seatId) taken[item.seatId] = item.status === 'CONFIRMED' ? 'S' : 'R';
  }
  const ga: Record<string, number> = {};
  for (const s of sections) ga[s.id] = Math.max(0, (s.capacity ?? 0) - s.allocated);

  await ctx.seats.replaceInventory(event.id, version, taken, ga);
  return version;
}

/** Ensures the mirror matches the current seat map version; returns that version. */
export async function ensureInventory(ctx: CoreContext, event: EventRow): Promise<number> {
  if (!event.seatMapId) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  const [mirrored, current] = await Promise.all([
    ctx.seats.inventoryVersion(event.id),
    seatMapVersion(ctx, event.seatMapId),
  ]);
  if (mirrored === current) return current;
  return rebuildInventory(ctx, event);
}

/** BullMQ job (queue `seat-locks`) that rebuilds an event's mirror a few seconds after a change. */
export const INVENTORY_REBUILD_JOB = 'rebuild-inventory';
export const INVENTORY_REBUILD_DELAY_MS = 5_000;

/** Job id of the delayed rebuild: one per event and plan version (bursts collapse). */
export function inventoryRebuildJobId(eventId: string, version: number): string {
  return `inventory-rebuild-${eventId}-${version}`;
}

/**
 * Queues a second rebuild of the event's inventory mirror a few seconds after a plan /
 * contingent save. The immediate rebuild after a save can race with a checkout (DB claim
 * committed, `commitGeneralAdmission` not yet applied) or a release and apply that delta twice;
 * the delayed rebuild re-reads PostgreSQL once those in-flight steps (milliseconds) are done.
 * Best effort: a failure is logged, never thrown (the save is committed already).
 */
export async function scheduleInventoryRebuild(
  ctx: Pick<CoreContext, 'jobs'>,
  eventId: string,
  version: number,
): Promise<boolean> {
  if (!ctx.jobs) return false;
  try {
    await ctx.jobs.add(
      QUEUE_NAMES.seatLocks,
      INVENTORY_REBUILD_JOB,
      { eventId },
      {
        jobId: inventoryRebuildJobId(eventId, version),
        delay: INVENTORY_REBUILD_DELAY_MS,
        attempts: 3,
        // Never keep finished jobs: a reused id (plan versions rewound by a restore) would
        // otherwise be swallowed by BullMQ's id dedupe for the retention period.
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return true;
  } catch (err) {
    coreLog.warn({ err, eventId }, '[inventory] delayed rebuild could not be queued');
    return false;
  }
}

/**
 * Body of the delayed rebuild: rebuilds the mirror from PostgreSQL and tells browsers the
 * corrected standing capacity. Returns false (no-op) for an event or plan that no longer exists.
 */
export async function reconcileEventInventory(ctx: CoreContext, eventId: string): Promise<boolean> {
  let event: EventRow;
  try {
    event = await getEventById(ctx, eventId);
  } catch (err) {
    if (err instanceof DomainError && err.status === 404) return false;
    throw err;
  }
  if (!event.seatMapId) return false;
  forgetSeatMapVersion(event.seatMapId);
  try {
    await rebuildInventory(ctx, event);
  } catch (err) {
    if (err instanceof DomainError && err.status === 404) return false;
    throw err;
  }
  const [remaining, open] = await Promise.all([
    ctx.seats.generalAdmissionRemaining(event.id),
    ctx.seats.generalAdmissionOpen(event.id),
  ]);
  if (Object.keys(open).length > 0) {
    await publishSeatDelta(ctx, { eventId: event.id, seats: [], ga: remaining, gaOpen: open });
  }
  return true;
}
