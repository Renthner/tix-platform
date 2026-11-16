import {
  devicePairingCodeEvents,
  events,
  orderItems,
  scannerDeviceEvents,
  seatMapEntrances,
  seatMaps,
  seats,
  tickets,
  withTransaction,
  pgErrorCode,
  seatMapCategories,
  type Executor,
} from '@tix/db';
import { seatMapFileSchema, type SeatMapFile } from '@tix/shared';
import { and, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { eventTags, invalidateShopCache } from '../cache/shop-cache';
import { getEventById } from '../events';
import { coreLog } from '../log';
import { rebuildInventory } from '../inventory';
import { deleteMediaAsset } from '../media-admin';
import { publishSeatDelta } from '../realtime';
import { applyTemplateCategoriesToEvent, cloneSeatMap } from './clone';
import {
  assertPlanStructure,
  prepareSymbols,
  uploadPlanImages,
  writeEventSeatMap,
} from './export-import';
import { forgetSeatMapVersion } from './public';

export type ReplaceSeatPlanSource =
  /** A copy of a venue master plan (must belong to the event's venue). */
  | { kind: 'template'; seatMapId: string }
  /** A parsed seat plan file (`parseSeatMapFile`). */
  | { kind: 'file'; file: SeatMapFile };

export interface ReplaceSeatPlanResult {
  seatMapId: string;
  /** Plan categories that matched an existing price category of the event by name. */
  categoriesReused: number;
  /** Plan categories that became new price categories (price 0, deactivated until priced). */
  categoriesCreated: number;
  /** Seats without a price category after the replacement. */
  unassignedSeats: number;
  /**
   * Scanner entrance assignments (devices and pairing codes of this event) that pointed at an
   * entrance of the old plan and were cleared - the devices keep scanning without an entrance.
   */
  scannerEntrancesCleared: number;
}

/**
 * Replaces the seat plan of a DRAFT event by a copy of another venue plan or by an imported
 * plan file. The event's current plan copy (incl. its edits and blocked seats) is deleted.
 *
 * Refused (409) unless the event is a DRAFT that has no order items (any status, test orders
 * included), no tickets and no live cart holds – the old seat ids must not be referenced by
 * anything. Pricing: price categories of the event are kept (prices, tariffs and the matrix are
 * untouched); the new plan's categories are mapped to them by name, categories that do not
 * exist yet are created without prices and deactivated, seats/sections without a category stay unassigned.
 *
 * One transaction with the event row locked; the new plan starts at old version + 1, so the
 * Redis inventory mirror and cached public maps of the old plan can never be mistaken for it.
 */
export async function replaceEventSeatPlan(
  ctx: CoreContext,
  input: {
    eventId: string;
    source: ReplaceSeatPlanSource;
    userId: string | null;
    /** Runs inside the transaction (the audit entry commits together with the swap). */
    audit?: (tx: Executor, result: ReplaceSeatPlanResult) => Promise<void>;
  },
): Promise<ReplaceSeatPlanResult> {
  const created: string[] = [];
  let oldSeatMapId: string | null = null;
  let committed = false;
  try {
    let file: SeatMapFile | null = null;
    let prepared: ReturnType<typeof prepareSymbols> = [];
    let uploads: Awaited<ReturnType<typeof uploadPlanImages>> | null = null;
    if (input.source.kind === 'file') {
      requireCapability(ctx, 'storage');
      file = seatMapFileSchema.parse(input.source.file);
      prepared = prepareSymbols(file.symbols);
      assertPlanStructure(file);
      uploads = await uploadPlanImages(ctx, file, input.userId, created);
    }

    const result = await withTransaction(ctx.db, async (tx) => {
      const locked = await tx.execute<{
        id: string;
        status: string;
        venue_id: string;
        title: string;
        seat_map_id: string | null;
      }>(
        sql`SELECT id, status, venue_id, title, seat_map_id FROM events WHERE id = ${input.eventId} FOR UPDATE`,
      );
      const event = locked.rows[0];
      if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
      if (event.status !== 'DRAFT') {
        throw new DomainError(
          'EVENT_NOT_DRAFT',
          'Only a draft event can get another seat plan',
          409,
        );
      }
      const [[items], [issued]] = await Promise.all([
        tx.select({ n: count() }).from(orderItems).where(eq(orderItems.eventId, event.id)),
        tx.select({ n: count() }).from(tickets).where(eq(tickets.eventId, event.id)),
      ]);
      if ((items?.n ?? 0) > 0 || (issued?.n ?? 0) > 0) {
        throw new DomainError(
          'SEAT_PLAN_IN_USE',
          'The event has orders or tickets (test orders included); its seat plan cannot be replaced',
          409,
        );
      }
      const holds = await ctx.seats.liveHoldCounts(event.id);
      if (holds.seats > 0 || holds.gaSpots > 0) {
        throw new DomainError(
          'SEAT_PLAN_HAS_HOLDS',
          'Seats of this event are currently held in shopping carts; try again later',
          409,
        );
      }

      oldSeatMapId = event.seat_map_id;
      // Lock the old plan row so its version cannot change between reading it and the swap.
      const old = oldSeatMapId
        ? (
            await tx.execute<{ version: number; name: string }>(
              sql`SELECT version, name FROM seat_maps WHERE id = ${oldSeatMapId} FOR UPDATE`,
            )
          ).rows[0]
        : undefined;
      const version = (old?.version ?? 0) + 1;
      const name = (old?.name ?? event.title).slice(0, 120);

      let outcome: ReplaceSeatPlanResult;
      if (input.source.kind === 'template') {
        const [template] = await tx
          .select({ id: seatMaps.id, venueId: seatMaps.venueId })
          .from(seatMaps)
          .where(and(eq(seatMaps.id, input.source.seatMapId), eq(seatMaps.kind, 'TEMPLATE')));
        if (!template) throw new DomainError('NOT_FOUND', 'Seat plan not found', 404);
        if (template.venueId !== event.venue_id) {
          throw new DomainError('TEMPLATE_MISMATCH', 'The plan belongs to another venue', 409);
        }
        const newId = await cloneSeatMap(tx, template.id, { kind: 'EVENT', name });
        await tx.update(seatMaps).set({ version }).where(eq(seatMaps.id, newId));
        await tx.update(events).set({ seatMapId: newId }).where(eq(events.id, event.id));
        const createdCategories = await applyTemplateCategoriesToEvent(tx, {
          eventId: event.id,
          seatMapId: newId,
          inactive: true,
        });
        const [planCategories] = await tx
          .select({ n: count() })
          .from(seatMapCategories)
          .where(eq(seatMapCategories.seatMapId, template.id));
        const [unassigned] = await tx
          .select({ n: count() })
          .from(seats)
          .where(
            and(eq(seats.seatMapId, newId), isNull(seats.removedAt), isNull(seats.priceCategoryId)),
          );
        outcome = {
          seatMapId: newId,
          categoriesCreated: createdCategories,
          categoriesReused: Math.max(0, (planCategories?.n ?? 0) - createdCategories),
          unassignedSeats: unassigned?.n ?? 0,
          scannerEntrancesCleared: 0,
        };
      } else {
        const written = await writeEventSeatMap(tx, {
          eventId: event.id,
          venueId: event.venue_id,
          file: file!,
          prepared,
          imageIds: uploads!.imageIds,
          backgroundAssetId: uploads!.backgroundAssetId,
          userId: input.userId,
          name,
          version,
        });
        outcome = {
          seatMapId: written.seatMapId,
          categoriesCreated: written.categoriesCreated,
          categoriesReused: written.categoriesReused,
          unassignedSeats: written.unassigned,
          scannerEntrancesCleared: 0,
        };
      }
      if (oldSeatMapId) {
        // Deleting the old plan sets entrance references of scanner devices / pairing codes to NULL
        // (their entrances go with the plan): count them so the admin can assign them again.
        const oldEntrances = tx
          .select({ id: seatMapEntrances.id })
          .from(seatMapEntrances)
          .where(eq(seatMapEntrances.seatMapId, oldSeatMapId));
        const [[devices], [codes]] = await Promise.all([
          tx
            .select({ n: count() })
            .from(scannerDeviceEvents)
            .where(
              and(
                eq(scannerDeviceEvents.eventId, event.id),
                isNotNull(scannerDeviceEvents.entranceId),
                inArray(scannerDeviceEvents.entranceId, oldEntrances),
              ),
            ),
          tx
            .select({ n: count() })
            .from(devicePairingCodeEvents)
            .where(
              and(
                eq(devicePairingCodeEvents.eventId, event.id),
                isNotNull(devicePairingCodeEvents.entranceId),
                inArray(devicePairingCodeEvents.entranceId, oldEntrances),
              ),
            ),
        ]);
        outcome.scannerEntrancesCleared = (devices?.n ?? 0) + (codes?.n ?? 0);
      }
      // The event points at the new plan now; the old copy (sections, rows, seats …) goes with it.
      if (oldSeatMapId) await tx.delete(seatMaps).where(eq(seatMaps.id, oldSeatMapId));
      await input.audit?.(tx, outcome);
      return outcome;
    });

    committed = true;
    // After the commit (best effort: the swap is done, a failing step is logged, not thrown).
    // GA holds of the old sections are not released here: the check above refuses the swap while
    // any exist, and one that races in belongs to a section that no longer exists (it expires).
    const step = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        coreLog.error(
          { err, eventId: input.eventId, seatMapId: result.seatMapId, step: name },
          'seat plan replaced, but a follow-up step failed',
        );
      }
    };
    if (oldSeatMapId) forgetSeatMapVersion(oldSeatMapId);
    forgetSeatMapVersion(result.seatMapId);
    await step('invalidateShopCache', () => invalidateShopCache(ctx, eventTags(input.eventId)));
    await step('rebuildInventory', async () => {
      const event = await getEventById(ctx, input.eventId);
      const locked = await ctx.seats.lockedSeatIds(event.id);
      await ctx.seats.forceRelease(event.id, locked);
      await rebuildInventory(ctx, event);
    });
    await step('publishSeatDelta', async () => {
      const [map] = await ctx.db
        .select({ version: seatMaps.version })
        .from(seatMaps)
        .where(eq(seatMaps.id, result.seatMapId));
      await publishSeatDelta(ctx, { eventId: input.eventId, seats: [], version: map?.version });
    });
    return result;
  } catch (err) {
    if (!committed) for (const id of created) await deleteMediaAsset(ctx, id).catch(() => {});
    if (!committed) {
      const code = pgErrorCode(err);
      // A reference to the old plan appeared concurrently (restrict foreign key) ...
      if (code === '23503') {
        throw new DomainError(
          'SEAT_PLAN_IN_USE',
          'The old seat plan is still referenced; its seat plan cannot be replaced',
          409,
        );
      }
      // ... or the swap deadlocked with a concurrent checkout: nothing changed, try again.
      if (code === '40P01') {
        throw new DomainError(
          'SEAT_PLAN_CONFLICT',
          'The seat plan is being used by a checkout right now; try again',
          409,
        );
      }
    }
    throw err;
  }
}
