import {
  events,
  isUniqueViolation,
  orderItems,
  pgErrorCode,
  priceCategories,
  priceCategoryTicketTypes,
  seatMapEntrances,
  seatMapSections,
  seatMaps,
  ticketTypes,
  withTransaction,
  type Executor,
} from '@tix/db';
import {
  changeEventSeatingSchema,
  contingentInputSchema,
  type ChangeEventSeatingInput,
  type ContingentInput,
  type EventSeatingMode,
  type SectionGeometry,
} from '@tix/shared';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from './context';
import { afterSeatMapSaved } from './seatmaps/after-save';
import {
  EMPTY_PLAN_HEIGHT,
  swapEventSeatPlan,
  type ReplaceSeatPlanResult,
} from './seatmaps/replace';

/**
 * Seating mode of an event and the quantity contingents of admission-only events.
 *
 * SEATED events sell from a copy of a venue plan (seat editor). ADMISSION events (e.g. a fair,
 * club entry) have no seating plan: their event map is a hidden plan without venue that holds
 * only STANDING sections ("contingents": name, price category, capacity). Contingents are sold
 * by quantity through the existing general-admission path (cart, Redis `ga:*`, checkout claim).
 */

export interface ChangeEventSeatingResult extends ReplaceSeatPlanResult {
  mode: EventSeatingMode;
  venueId: string | null;
}

/**
 * Changes seating mode, venue and plan of a DRAFT event in one transaction (same guards and
 * follow-up steps as replacing the plan: the event must be a DRAFT without order items – test
 * orders included –, tickets and live cart holds; the current plan copy is deleted).
 *  - SEATED: venue required; `templateId` = copy of one of the venue's plans, none = empty plan.
 *  - ADMISSION: venue optional, no template; an empty hidden plan, contingents follow.
 */
export async function changeEventSeating(
  ctx: CoreContext,
  input: ChangeEventSeatingInput & {
    eventId: string;
    userId: string | null;
    /** Runs inside the transaction (the audit entry commits together with the change). */
    audit?: (tx: Executor, result: ChangeEventSeatingResult) => Promise<void>;
  },
): Promise<ChangeEventSeatingResult> {
  const parsed = changeEventSeatingSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid seating change', 422, {
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }
  const { mode, venueId, templateId } = parsed.data;
  const target = { mode, venueId };
  const result = await swapEventSeatPlan(ctx, {
    eventId: input.eventId,
    source: templateId ? { kind: 'template', seatMapId: templateId } : { kind: 'empty' },
    target,
    userId: input.userId,
    audit: input.audit ? (tx, r) => input.audit!(tx, { ...r, ...target }) : undefined,
  });
  return { ...result, ...target };
}

// ─── Contingents ────────────────────────────────────────────────────────────

export interface Contingent {
  id: string;
  name: string;
  capacity: number;
  /** Sold + reserved spots (order items holding inventory). */
  allocated: number;
  /** Spots currently held in shopping carts. */
  held: number;
  priceCategoryId: string | null;
  entranceId: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface ContingentOverview {
  eventId: string;
  seatMapId: string;
  contingents: Contingent[];
  entrances: { id: string; name: string; code: string }[];
}

async function loadAdmissionEvent(db: Executor, eventId: string) {
  const [event] = await db
    .select({ id: events.id, seatingMode: events.seatingMode, seatMapId: events.seatMapId })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  if (event.seatingMode !== 'ADMISSION') {
    throw new DomainError(
      'EVENT_NOT_ADMISSION',
      'Contingents exist only for admission-only events',
      409,
    );
  }
  if (!event.seatMapId) {
    throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  }
  return { ...event, seatMapId: event.seatMapId };
}

/** Contingents of an admission-only event with sold / held counts and the plan's entrances. */
export async function listContingents(
  ctx: CoreContext,
  eventId: string,
): Promise<ContingentOverview> {
  const event = await loadAdmissionEvent(ctx.db, eventId);
  const [rows, entrances, held] = await Promise.all([
    ctx.db
      .select()
      .from(seatMapSections)
      .where(
        and(
          eq(seatMapSections.seatMapId, event.seatMapId),
          eq(seatMapSections.type, 'STANDING'),
          isNull(seatMapSections.removedAt),
        ),
      )
      .orderBy(asc(seatMapSections.sortOrder), asc(seatMapSections.name)),
    ctx.db
      .select({ id: seatMapEntrances.id, name: seatMapEntrances.name, code: seatMapEntrances.code })
      .from(seatMapEntrances)
      .where(eq(seatMapEntrances.seatMapId, event.seatMapId))
      .orderBy(asc(seatMapEntrances.sortOrder), asc(seatMapEntrances.name)),
    ctx.seats.generalAdmissionHeldBySection(event.id),
  ]);
  return {
    eventId: event.id,
    seatMapId: event.seatMapId,
    entrances,
    contingents: rows.map((s) => ({
      id: s.id,
      name: s.name,
      capacity: s.capacity ?? 0,
      allocated: s.allocatedCount,
      held: held[s.id] ?? 0,
      priceCategoryId: s.priceCategoryId,
      entranceId: s.entranceId,
      sortOrder: s.sortOrder,
      isActive: s.isActive,
    })),
  };
}

// Placeholder geometry: contingents are not drawn by an admin, but the (shared) public plan
// renderer needs a shape. Laid out on a grid so the plan stays readable.
const GRID_COLUMNS = 4;
const CELL_W = 450;
const CELL_H = 300;
const MARGIN = 100;

function contingentGeometry(index: number): SectionGeometry {
  return {
    type: 'rect',
    x: MARGIN + (index % GRID_COLUMNS) * CELL_W,
    y: MARGIN + Math.floor(index / GRID_COLUMNS) * CELL_H,
    width: CELL_W - 50,
    height: CELL_H - 50,
    rotation: 0,
  };
}

/**
 * Locks the event row (KEY SHARE – enough to conflict with a seating change, which takes the row
 * FOR UPDATE, without blocking ordinary event edits) and its plan row (the version bump), and
 * checks that the event is admission-only.
 */
async function lockAdmissionPlan(tx: Executor, eventId: string) {
  const locked = await tx.execute<{
    seating_mode: EventSeatingMode;
    seat_map_id: string | null;
  }>(sql`SELECT seating_mode, seat_map_id FROM events WHERE id = ${eventId} FOR KEY SHARE`);
  const event = locked.rows[0];
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  if (event.seating_mode !== 'ADMISSION') {
    throw new DomainError(
      'EVENT_NOT_ADMISSION',
      'Contingents exist only for admission-only events',
      409,
    );
  }
  if (!event.seat_map_id) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  const map = (
    await tx.execute<{ version: number; canvas_height: number }>(
      sql`SELECT version, canvas_height FROM seat_maps WHERE id = ${event.seat_map_id} FOR UPDATE`,
    )
  ).rows[0];
  if (!map) throw new DomainError('SEAT_MAP_NOT_FOUND', 'Event has no seat map', 404);
  return { seatMapId: event.seat_map_id, version: map.version, canvasHeight: map.canvas_height };
}

async function bumpPlanVersion(
  tx: Executor,
  seatMapId: string,
  version: number,
  canvasHeight?: number,
): Promise<number> {
  const next = version + 1;
  await tx
    .update(seatMaps)
    .set({ version: next, ...(canvasHeight ? { canvasHeight } : {}) })
    .where(eq(seatMaps.id, seatMapId));
  return next;
}

/**
 * A save / remove that still deadlocked (or hit a serialization failure) after the retries of
 * `withTransaction`: nothing changed, the admin can simply try again.
 */
function conflictError(err: unknown): DomainError | null {
  const code = pgErrorCode(err);
  if (code === '40P01' || code === '40001') {
    return new DomainError(
      'CONTINGENT_CONFLICT',
      'The contingent is being changed by another action right now; try again',
      409,
    );
  }
  return null;
}

export interface SavedContingent {
  id: string;
  version: number;
  created: boolean;
}

/**
 * Creates (no `id`) or updates a contingent. Allowed in any event status (like the seat editor:
 * the event plan stays editable after publishing). The capacity can never drop below the spots
 * sold / reserved plus those currently held in carts, and the price category cannot change while
 * any spot is sold, reserved or held. Refreshes the Redis inventory, the public plan version and
 * the shop cache afterwards.
 */
export async function saveContingent(
  ctx: CoreContext,
  eventId: string,
  raw: ContingentInput,
  options: {
    /** Runs inside the transaction (the audit entry commits together with the change). */
    audit?: (tx: Executor, result: SavedContingent) => Promise<void>;
  } = {},
): Promise<SavedContingent> {
  const parsed = contingentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid contingent', 422, {
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }
  const input = parsed.data;
  let saved: SavedContingent;
  try {
    saved = await withTransaction(ctx.db, async (tx): Promise<SavedContingent> => {
      const plan = await lockAdmissionPlan(tx, eventId);
      const [category] = await tx
        .select({ id: priceCategories.id })
        .from(priceCategories)
        .where(
          and(eq(priceCategories.id, input.priceCategoryId), eq(priceCategories.eventId, eventId)),
        );
      if (!category) {
        throw new DomainError('PRICE_CATEGORY_NOT_FOUND', 'Price category not found', 422, {
          field: 'priceCategoryId',
        });
      }
      const entranceId = input.entranceId ?? null;
      if (entranceId) {
        const [entrance] = await tx
          .select({ id: seatMapEntrances.id })
          .from(seatMapEntrances)
          .where(
            and(
              eq(seatMapEntrances.id, entranceId),
              eq(seatMapEntrances.seatMapId, plan.seatMapId),
            ),
          );
        if (!entrance) {
          throw new DomainError('ENTRANCE_NOT_FOUND', 'Entrance not found', 422, {
            field: 'entranceId',
          });
        }
      }

      if (input.id) {
        // NO KEY UPDATE: the row's key never changes here, so concurrent order-item inserts
        // (foreign key -> KEY SHARE) are not blocked; the checkout's allocation UPDATE still waits.
        const current = (
          await tx.execute<{ allocated_count: number; price_category_id: string | null }>(
            sql`SELECT allocated_count, price_category_id FROM seat_map_sections
                WHERE id = ${input.id} AND seat_map_id = ${plan.seatMapId}
                  AND type = 'STANDING' AND removed_at IS NULL
                FOR NO KEY UPDATE`,
          )
        ).rows[0];
        if (!current) throw new DomainError('CONTINGENT_NOT_FOUND', 'Contingent not found', 404);
        const held = (await ctx.seats.generalAdmissionHeldBySection(eventId))[input.id] ?? 0;
        if (
          current.price_category_id !== input.priceCategoryId &&
          current.allocated_count + held > 0
        ) {
          throw new DomainError(
            'CONTINGENT_CATEGORY_IN_USE',
            'The price category cannot change while spots are sold, reserved or held in carts',
            409,
            { allocated: current.allocated_count, held },
          );
        }
        const minimum = current.allocated_count + held;
        if (input.capacity < minimum) {
          throw new DomainError(
            'CONTINGENT_CAPACITY_TOO_LOW',
            'The capacity cannot be lower than the spots sold, reserved or held in carts',
            409,
            { minimum, allocated: current.allocated_count, held, field: 'capacity' },
          );
        }
        await tx
          .update(seatMapSections)
          .set({
            name: input.name,
            ticketLabel: input.name,
            capacity: input.capacity,
            priceCategoryId: input.priceCategoryId,
            entranceId,
            ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
            updatedAt: new Date(),
          })
          .where(eq(seatMapSections.id, input.id));
        const updated = {
          id: input.id,
          version: await bumpPlanVersion(tx, plan.seatMapId, plan.version),
          created: false,
        };
        await options.audit?.(tx, updated);
        return updated;
      }

      const [existing] = await tx
        .select({
          n: count(),
          maxSort: sql<number>`COALESCE(MAX(${seatMapSections.sortOrder}), -1)`,
        })
        .from(seatMapSections)
        .where(
          and(eq(seatMapSections.seatMapId, plan.seatMapId), isNull(seatMapSections.removedAt)),
        );
      const index = existing?.n ?? 0;
      const [created] = await tx
        .insert(seatMapSections)
        .values({
          seatMapId: plan.seatMapId,
          type: 'STANDING',
          name: input.name,
          ticketLabel: input.name,
          geometry: contingentGeometry(index),
          capacity: input.capacity,
          priceCategoryId: input.priceCategoryId,
          entranceId,
          sortOrder: input.sortOrder ?? Number(existing?.maxSort ?? -1) + 1,
        })
        .returning({ id: seatMapSections.id });
      const neededHeight = MARGIN * 2 + (Math.floor(index / GRID_COLUMNS) + 1) * CELL_H;
      const inserted = {
        id: created!.id,
        version: await bumpPlanVersion(
          tx,
          plan.seatMapId,
          plan.version,
          Math.max(plan.canvasHeight, EMPTY_PLAN_HEIGHT, neededHeight),
        ),
        created: true,
      };
      await options.audit?.(tx, inserted);
      return inserted;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'seat_map_sections_name_uq')) {
      throw new DomainError('CONTINGENT_NAME_TAKEN', 'A contingent with this name exists', 409, {
        field: 'name',
      });
    }
    throw conflictError(err) ?? err;
  }
  await afterContingentChange(ctx, eventId, saved.version);
  return saved;
}

/**
 * Removes a contingent. Refused while spots are sold / reserved or held in carts. A contingent
 * that order items (cancelled ones) still reference is soft-removed, otherwise deleted.
 */
export async function removeContingent(
  ctx: CoreContext,
  eventId: string,
  contingentId: string,
  options: {
    /** Runs inside the transaction (the audit entry commits together with the removal). */
    audit?: (tx: Executor, result: { softRemoved: boolean }) => Promise<void>;
  } = {},
): Promise<{ softRemoved: boolean }> {
  const outcome = await withTransaction(ctx.db, async (tx) => {
    const plan = await lockAdmissionPlan(tx, eventId);
    // FOR UPDATE (not NO KEY UPDATE): the row may be deleted below.
    const current = (
      await tx.execute<{ allocated_count: number }>(
        sql`SELECT allocated_count FROM seat_map_sections
            WHERE id = ${contingentId} AND seat_map_id = ${plan.seatMapId}
              AND type = 'STANDING' AND removed_at IS NULL
            FOR UPDATE`,
      )
    ).rows[0];
    if (!current) throw new DomainError('CONTINGENT_NOT_FOUND', 'Contingent not found', 404);
    const held = (await ctx.seats.generalAdmissionHeldBySection(eventId))[contingentId] ?? 0;
    if (current.allocated_count > 0 || held > 0) {
      throw new DomainError(
        'CONTINGENT_IN_USE',
        'Spots of this contingent are sold, reserved or held in carts',
        409,
        { allocated: current.allocated_count, held },
      );
    }
    const [referenced] = await tx
      .select({ n: count() })
      .from(orderItems)
      .where(eq(orderItems.sectionId, contingentId));
    const softRemoved = (referenced?.n ?? 0) > 0;
    if (softRemoved) {
      await tx
        .update(seatMapSections)
        .set({ removedAt: new Date(), updatedAt: new Date() })
        .where(eq(seatMapSections.id, contingentId));
    } else {
      await tx.delete(seatMapSections).where(eq(seatMapSections.id, contingentId));
    }
    await options.audit?.(tx, { softRemoved });
    return {
      softRemoved,
      version: await bumpPlanVersion(tx, plan.seatMapId, plan.version),
    };
  }).catch((err: unknown) => {
    throw conflictError(err) ?? err;
  });
  await afterContingentChange(ctx, eventId, outcome.version);
  return { softRemoved: outcome.softRemoved };
}

/** Same follow-up as a seat editor save: Redis inventory, plan version, shop cache, browsers. */
async function afterContingentChange(
  ctx: CoreContext,
  eventId: string,
  version: number,
): Promise<void> {
  await afterSeatMapSaved(ctx, {
    ok: true,
    kind: 'EVENT',
    eventId,
    version,
    removedSeatIds: [],
    blockedSeatIds: [],
  });
}

// ─── Publishing ─────────────────────────────────────────────────────────────

/**
 * Number of contingents of an admission-only event that can be sold online: not removed,
 * active, capacity > 0, with an active price category offered with at least one active tariff
 * of the ONLINE channel. Publishing needs at least one.
 */
export async function countSellableContingents(
  db: Executor,
  event: { id: string; seatMapId: string | null },
): Promise<number> {
  if (!event.seatMapId) return 0;
  const offered = db
    .select({ id: priceCategoryTicketTypes.priceCategoryId })
    .from(priceCategoryTicketTypes)
    .innerJoin(ticketTypes, eq(ticketTypes.id, priceCategoryTicketTypes.ticketTypeId))
    .where(
      and(
        eq(priceCategoryTicketTypes.isActive, true),
        eq(ticketTypes.isActive, true),
        eq(ticketTypes.eventId, event.id),
        sql`'ONLINE' = ANY(${ticketTypes.channels})`,
      ),
    );
  const [row] = await db
    .select({ n: count() })
    .from(seatMapSections)
    .innerJoin(priceCategories, eq(priceCategories.id, seatMapSections.priceCategoryId))
    .where(
      and(
        eq(seatMapSections.seatMapId, event.seatMapId),
        eq(seatMapSections.type, 'STANDING'),
        eq(seatMapSections.isActive, true),
        isNull(seatMapSections.removedAt),
        sql`${seatMapSections.capacity} > 0`,
        eq(priceCategories.eventId, event.id),
        eq(priceCategories.isActive, true),
        inArray(priceCategories.id, offered),
      ),
    );
  return row?.n ?? 0;
}

/** Refuses publishing an admission-only event without a sellable contingent. */
export async function assertAdmissionSellable(
  db: Executor,
  event: { id: string; seatMapId: string | null; seatingMode: EventSeatingMode },
): Promise<void> {
  if (event.seatingMode !== 'ADMISSION') return;
  if ((await countSellableContingents(db, event)) === 0) {
    throw new DomainError(
      'ADMISSION_NOT_SELLABLE',
      'An admission-only event needs at least one contingent with capacity and an offered price category',
      409,
    );
  }
}
