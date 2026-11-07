import { events, fees, taxRates, type Executor } from '@tix/db';
import {
  eventFeeInputSchema,
  feeOrderSchema,
  globalFeeInputSchema,
  type FeeInput,
  type FeeTarget,
  type ParsedFeeInput,
} from '@tix/shared';
import { and, asc, count, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';
import { DomainError } from './context';

/**
 * Service / booking fees administration – global defaults, adjustable per event.
 *
 * Rows of `fees` (see docs/DATABASE.md → "Fee resolution"):
 *  - `event_id NULL`                       → global fee (PER_TICKET / PER_EVENT / PER_ORDER)
 *  - `event_id` + `overrides_fee_id`       → the event's version of a global fee: an active
 *    override replaces all fields of the global fee for that event, an inactive one waives it
 *  - `event_id`, no `overrides_fee_id`     → additional fee of this event only
 *
 * The checkout (`orders/pricing.ts` → `effectiveEventFees`) resolves the effective fees of an
 * event as `override ?? global` per global PER_TICKET / PER_EVENT fee (charged when active)
 * plus the event-only fees; PER_ORDER fees are charged once per order and cannot be adjusted
 * per event. Orders keep snapshots in `order_fees`, so editing or deleting fees never alters
 * existing orders.
 *
 * Every function accepts a transaction, so the caller can write its audit entry atomically.
 */

export type FeeRow = typeof fees.$inferSelect;

/** Sort-order gap between global fees (room for manual inserts). */
const SORT_STEP = 10;

export interface GlobalFeeListItem extends FeeRow {
  taxRateName: string | null;
  taxRateBasisPoints: number | null;
  /** Events with an active override (own values). */
  overrideCount: number;
  /** Events that waive this fee. */
  waivedCount: number;
}

/** How a global fee applies to one event. */
export type EventFeeState = 'INHERITED' | 'OVERRIDDEN' | 'WAIVED';

export interface EventGlobalFee {
  global: FeeRow;
  /** The event's override row (also present when waived). */
  override: FeeRow | null;
  state: EventFeeState;
  /** Values that apply for this event: the active override, otherwise the global fee. */
  effective: FeeRow;
  /** True when the fee is charged for this event (subject to payment method / channel). */
  charged: boolean;
}

export interface EventFeesView {
  eventId: string;
  currency: string;
  /** The event's own tax rate (used by fees without an explicit rate). */
  eventTaxRateId: string;
  /** Global PER_TICKET / PER_EVENT fees with the event's adjustment. */
  globals: EventGlobalFee[];
  /** Global PER_ORDER fees – charged once per order, not adjustable per event (info only). */
  orderFees: FeeRow[];
  /** Additional fees of this event only. */
  own: FeeRow[];
}

function parseFee(input: FeeInput, target: FeeTarget): ParsedFeeInput {
  const schema = target === 'GLOBAL' ? globalFeeInputSchema : eventFeeInputSchema;
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const scopeIssue = parsed.error.issues.find((i) => i.path[0] === 'scope');
  if (target === 'EVENT' && input.scope === 'PER_ORDER' && scopeIssue) {
    throw new DomainError(
      'FEE_SCOPE_NOT_ALLOWED',
      'Fees charged once per order can only be defined globally',
      400,
    );
  }
  throw new DomainError('FEE_INVALID', 'Invalid fee', 400, {
    issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** Columns written from an input (sort order and links are handled by the callers). */
function feeValues(data: ParsedFeeInput) {
  return {
    name: data.name,
    scope: data.scope,
    calculation: data.calculation,
    value: data.value,
    taxRateId: data.taxRateId,
    paymentMethods: data.paymentMethods,
    channels: data.channels,
    isActive: data.isActive,
  };
}

async function assertTaxRate(db: Executor, taxRateId: string | null): Promise<void> {
  if (!taxRateId) return;
  const [row] = await db
    .select({ id: taxRates.id })
    .from(taxRates)
    .where(eq(taxRates.id, taxRateId));
  if (!row) throw new DomainError('TAX_RATE_NOT_FOUND', 'Tax rate not found', 404);
}

async function lockEvent(
  db: Executor,
  eventId: string,
): Promise<{ id: string; currency: string; taxRateId: string }> {
  const [row] = await db
    .select({ id: events.id, currency: events.currency, taxRateId: events.taxRateId })
    .from(events)
    .where(eq(events.id, eventId))
    .for('share');
  if (!row) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  return row;
}

async function lockGlobalFee(db: Executor, feeId: string): Promise<FeeRow> {
  const [row] = await db
    .select()
    .from(fees)
    .where(and(eq(fees.id, feeId), isNull(fees.eventId)))
    .for('update');
  if (!row) throw new DomainError('FEE_NOT_FOUND', 'Fee not found', 404);
  return row;
}

// ─── Global fees ────────────────────────────────────────────────────────────

/** Global fees in charging order, with tax rate and per-event adjustment counts. */
export async function listGlobalFees(db: Executor): Promise<GlobalFeeListItem[]> {
  const [rows, adjustments] = await Promise.all([
    db
      .select({
        fee: fees,
        taxRateName: taxRates.name,
        taxRateBasisPoints: taxRates.rateBasisPoints,
      })
      .from(fees)
      .leftJoin(taxRates, eq(taxRates.id, fees.taxRateId))
      .where(isNull(fees.eventId))
      .orderBy(asc(fees.sortOrder), asc(fees.createdAt)),
    db
      .select({ feeId: fees.overridesFeeId, isActive: fees.isActive, n: count() })
      .from(fees)
      .where(isNotNull(fees.overridesFeeId))
      .groupBy(fees.overridesFeeId, fees.isActive),
  ]);
  const counts = new Map<string, { overrideCount: number; waivedCount: number }>();
  for (const a of adjustments) {
    const entry = counts.get(a.feeId!) ?? { overrideCount: 0, waivedCount: 0 };
    if (a.isActive) entry.overrideCount += a.n;
    else entry.waivedCount += a.n;
    counts.set(a.feeId!, entry);
  }
  return rows.map((r) => ({
    ...r.fee,
    taxRateName: r.taxRateName,
    taxRateBasisPoints: r.taxRateBasisPoints,
    ...(counts.get(r.fee.id) ?? { overrideCount: 0, waivedCount: 0 }),
  }));
}

/** Creates a global fee at the end of the charging order. */
export async function createGlobalFee(db: Executor, input: FeeInput): Promise<FeeRow> {
  const data = parseFee(input, 'GLOBAL');
  return db.transaction(async (tx) => {
    await assertTaxRate(tx, data.taxRateId);
    const [last] = await tx
      .select({ value: max(fees.sortOrder) })
      .from(fees)
      .where(isNull(fees.eventId));
    const [row] = await tx
      .insert(fees)
      .values({ ...feeValues(data), sortOrder: (last?.value ?? 0) + SORT_STEP })
      .returning();
    return row!;
  });
}

/**
 * Updates a global fee. Events that override it keep their own values; a fee with event
 * adjustments cannot become PER_ORDER (`FEE_HAS_OVERRIDES`) because order fees are not
 * adjustable per event – reset those events first.
 */
export async function updateGlobalFee(
  db: Executor,
  feeId: string,
  input: FeeInput,
): Promise<{ before: FeeRow; after: FeeRow }> {
  const data = parseFee(input, 'GLOBAL');
  return db.transaction(async (tx) => {
    const before = await lockGlobalFee(tx, feeId);
    await assertTaxRate(tx, data.taxRateId);
    if (data.scope === 'PER_ORDER' && before.scope !== 'PER_ORDER') {
      const [adjusted] = await tx
        .select({ n: count() })
        .from(fees)
        .where(eq(fees.overridesFeeId, feeId));
      if ((adjusted?.n ?? 0) > 0) {
        throw new DomainError(
          'FEE_HAS_OVERRIDES',
          'Events adjust this fee – reset them before charging it once per order',
          409,
          { events: adjusted!.n },
        );
      }
    }
    const [after] = await tx
      .update(fees)
      .set(feeValues(data))
      .where(eq(fees.id, feeId))
      .returning();
    return { before, after: after! };
  });
}

/** Activates / deactivates a global fee (events with an active override keep charging it). */
export async function setGlobalFeeActive(
  db: Executor,
  feeId: string,
  isActive: boolean,
): Promise<FeeRow> {
  const [row] = await db
    .update(fees)
    .set({ isActive })
    .where(and(eq(fees.id, feeId), isNull(fees.eventId)))
    .returning();
  if (!row) throw new DomainError('FEE_NOT_FOUND', 'Fee not found', 404);
  return row;
}

/**
 * Deletes a global fee together with its event overrides (FK cascade). Existing orders keep
 * their fee lines (`order_fees.fee_id` is set to NULL).
 */
export async function deleteGlobalFee(
  db: Executor,
  feeId: string,
): Promise<{ fee: FeeRow; removedOverrides: number }> {
  return db.transaction(async (tx) => {
    const fee = await lockGlobalFee(tx, feeId);
    const [adjusted] = await tx
      .select({ n: count() })
      .from(fees)
      .where(eq(fees.overridesFeeId, feeId));
    await tx.delete(fees).where(eq(fees.id, feeId));
    return { fee, removedOverrides: adjusted?.n ?? 0 };
  });
}

/**
 * Sets the charging order of the global fees. `orderedIds` must list every global fee
 * exactly once. Overrides follow the position of their global fee.
 */
export async function reorderGlobalFees(db: Executor, orderedIds: string[]): Promise<void> {
  const parsed = feeOrderSchema.safeParse(orderedIds);
  if (!parsed.success) throw new DomainError('FEE_ORDER_INVALID', 'Invalid fee order', 400);
  await db.transaction(async (tx) => {
    const current = await tx
      .select({ id: fees.id })
      .from(fees)
      .where(isNull(fees.eventId))
      .for('update');
    const known = new Set(current.map((r) => r.id));
    if (known.size !== orderedIds.length || orderedIds.some((id) => !known.has(id))) {
      throw new DomainError(
        'FEE_ORDER_INVALID',
        'The fee list changed in the meantime, reload the page',
        409,
      );
    }
    for (const [index, id] of orderedIds.entries()) {
      const sortOrder = (index + 1) * SORT_STEP;
      await tx.update(fees).set({ sortOrder }).where(eq(fees.id, id));
      await tx.update(fees).set({ sortOrder }).where(eq(fees.overridesFeeId, id));
    }
  });
}

// ─── Per event ──────────────────────────────────────────────────────────────

/** Effective fee list of an event: every global fee with its adjustment + event-only fees. */
export async function getEventFees(db: Executor, eventId: string): Promise<EventFeesView> {
  const [event] = await db
    .select({ id: events.id, currency: events.currency, taxRateId: events.taxRateId })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  const rows = await db
    .select()
    .from(fees)
    .where(sql`${fees.eventId} IS NULL OR ${fees.eventId} = ${eventId}`)
    .orderBy(asc(fees.sortOrder), asc(fees.createdAt));
  const overrides = new Map(
    rows
      .filter((f) => f.eventId === eventId && f.overridesFeeId)
      .map((f) => [f.overridesFeeId!, f]),
  );
  const globals: EventGlobalFee[] = rows
    .filter((f) => f.eventId === null && f.scope !== 'PER_ORDER')
    .map((global) => {
      const override = overrides.get(global.id) ?? null;
      const state: EventFeeState = !override
        ? 'INHERITED'
        : override.isActive
          ? 'OVERRIDDEN'
          : 'WAIVED';
      const effective = override ?? global;
      return { global, override, state, effective, charged: effective.isActive };
    });
  return {
    eventId: event.id,
    currency: event.currency,
    eventTaxRateId: event.taxRateId,
    globals,
    orderFees: rows.filter((f) => f.eventId === null && f.scope === 'PER_ORDER'),
    own: rows.filter((f) => f.eventId === eventId && !f.overridesFeeId),
  };
}

async function existingOverride(
  tx: Executor,
  eventId: string,
  globalFeeId: string,
): Promise<FeeRow | null> {
  const [row] = await tx
    .select()
    .from(fees)
    .where(and(eq(fees.eventId, eventId), eq(fees.overridesFeeId, globalFeeId)))
    .for('update');
  return row ?? null;
}

function assertOverridable(global: FeeRow): void {
  if (global.scope === 'PER_ORDER') {
    throw new DomainError(
      'FEE_NOT_OVERRIDABLE',
      'Fees charged once per order cannot be adjusted per event',
      409,
    );
  }
}

/**
 * Gives an event its own version of a global fee (other value, calculation, scope, payment
 * methods …). The override is always active – use `waiveEventFee` to drop the fee.
 */
export async function setEventFeeOverride(
  db: Executor,
  eventId: string,
  globalFeeId: string,
  input: FeeInput,
): Promise<{ before: FeeRow | null; after: FeeRow }> {
  const data = parseFee({ ...input, isActive: true }, 'EVENT');
  return db.transaction(async (tx) => {
    await lockEvent(tx, eventId);
    const global = await lockGlobalFee(tx, globalFeeId);
    assertOverridable(global);
    await assertTaxRate(tx, data.taxRateId);
    const before = await existingOverride(tx, eventId, globalFeeId);
    const values = { ...feeValues(data), sortOrder: global.sortOrder };
    const [after] = before
      ? await tx.update(fees).set(values).where(eq(fees.id, before.id)).returning()
      : await tx
          .insert(fees)
          .values({ ...values, eventId, overridesFeeId: globalFeeId })
          .returning();
    return { before, after: after! };
  });
}

/**
 * Waives a global fee for one event (inactive override). Values of an existing override are
 * kept, so overriding again starts from them.
 */
export async function waiveEventFee(
  db: Executor,
  eventId: string,
  globalFeeId: string,
): Promise<FeeRow> {
  return db.transaction(async (tx) => {
    await lockEvent(tx, eventId);
    const global = await lockGlobalFee(tx, globalFeeId);
    assertOverridable(global);
    const existing = await existingOverride(tx, eventId, globalFeeId);
    if (existing) {
      const [row] = await tx
        .update(fees)
        .set({ isActive: false })
        .where(eq(fees.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await tx
      .insert(fees)
      .values({
        eventId,
        overridesFeeId: globalFeeId,
        name: global.name,
        scope: global.scope,
        calculation: global.calculation,
        value: global.value,
        taxRateId: global.taxRateId,
        paymentMethods: global.paymentMethods,
        channels: global.channels,
        isActive: false,
        sortOrder: global.sortOrder,
      })
      .returning();
    return row!;
  });
}

/** Removes the event's adjustment – the global fee applies again. Returns the removed row. */
export async function resetEventFee(
  db: Executor,
  eventId: string,
  globalFeeId: string,
): Promise<FeeRow | null> {
  const [removed] = await db
    .delete(fees)
    .where(and(eq(fees.eventId, eventId), eq(fees.overridesFeeId, globalFeeId)))
    .returning();
  return removed ?? null;
}

/** Additional fee for one event only (PER_TICKET / PER_EVENT). */
export async function createEventFee(
  db: Executor,
  eventId: string,
  input: FeeInput,
): Promise<FeeRow> {
  const data = parseFee(input, 'EVENT');
  return db.transaction(async (tx) => {
    await lockEvent(tx, eventId);
    await assertTaxRate(tx, data.taxRateId);
    let sortOrder = data.sortOrder;
    if (sortOrder === undefined) {
      const [last] = await tx
        .select({ value: max(fees.sortOrder) })
        .from(fees)
        .where(sql`${fees.eventId} IS NULL OR ${fees.eventId} = ${eventId}`);
      sortOrder = (last?.value ?? 0) + SORT_STEP;
    }
    const [row] = await tx
      .insert(fees)
      .values({ ...feeValues(data), eventId, sortOrder })
      .returning();
    return row!;
  });
}

async function lockEventOnlyFee(tx: Executor, eventId: string, feeId: string): Promise<FeeRow> {
  const [row] = await tx
    .select()
    .from(fees)
    .where(and(eq(fees.id, feeId), eq(fees.eventId, eventId), isNull(fees.overridesFeeId)))
    .for('update');
  if (!row) throw new DomainError('FEE_NOT_FOUND', 'Fee not found', 404);
  return row;
}

export async function updateEventFee(
  db: Executor,
  eventId: string,
  feeId: string,
  input: FeeInput,
): Promise<{ before: FeeRow; after: FeeRow }> {
  const data = parseFee(input, 'EVENT');
  return db.transaction(async (tx) => {
    const before = await lockEventOnlyFee(tx, eventId, feeId);
    await assertTaxRate(tx, data.taxRateId);
    const [after] = await tx
      .update(fees)
      .set({ ...feeValues(data), sortOrder: data.sortOrder ?? before.sortOrder })
      .where(eq(fees.id, feeId))
      .returning();
    return { before, after: after! };
  });
}

export async function deleteEventFee(
  db: Executor,
  eventId: string,
  feeId: string,
): Promise<FeeRow> {
  return db.transaction(async (tx) => {
    const fee = await lockEventOnlyFee(tx, eventId, feeId);
    await tx.delete(fees).where(eq(fees.id, feeId));
    return fee;
  });
}
