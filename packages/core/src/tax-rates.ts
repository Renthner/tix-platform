import {
  events,
  fees,
  findPgError,
  isUniqueViolation,
  PG_ERROR,
  taxRates,
  type Executor,
} from '@tix/db';
import { taxRateInputSchema, type TaxRateInput } from '@tix/shared';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import { DomainError } from './context';

/**
 * Tax rates (VAT) administration.
 *
 * Events reference one rate (`events.tax_rate_id`), fees optionally their own one. Orders,
 * invoices and fee lines snapshot the rate in basis points, so editing a rate only affects
 * future sales and only `events` / `fees` references block a deletion.
 *
 * Every function accepts a transaction, so the caller can write its audit entry atomically.
 */

export type TaxRateRow = typeof taxRates.$inferSelect;

export interface TaxRateWithUsage extends TaxRateRow {
  /** Events using the rate (any status). */
  eventCount: number;
  /** Global and event fees using the rate explicitly. */
  feeCount: number;
}

function parseInput(input: TaxRateInput): TaxRateInput {
  const parsed = taxRateInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError('TAX_RATE_INVALID', 'Invalid tax rate', 400, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

function rowValues(input: TaxRateInput) {
  return {
    name: input.name,
    rateBasisPoints: input.rateBasisPoints,
    invoiceNote: input.invoiceNote,
    isDefault: input.isDefault,
    isActive: input.isActive,
    sortOrder: input.sortOrder,
  };
}

function nameTaken(err: unknown): never {
  if (isUniqueViolation(err, 'tax_rates_name_uq')) {
    throw new DomainError('TAX_RATE_NAME_TAKEN', 'A tax rate with this name already exists', 409);
  }
  throw err;
}

/** All tax rates (active first by sort order) with the number of events / fees using them. */
export async function listTaxRatesWithUsage(db: Executor): Promise<TaxRateWithUsage[]> {
  const [rows, eventCounts, feeCounts] = await Promise.all([
    db.select().from(taxRates).orderBy(asc(taxRates.sortOrder), asc(taxRates.name)),
    db.select({ id: events.taxRateId, n: count() }).from(events).groupBy(events.taxRateId),
    db.select({ id: fees.taxRateId, n: count() }).from(fees).groupBy(fees.taxRateId),
  ]);
  const byEvent = new Map(eventCounts.map((r) => [r.id, r.n]));
  const byFee = new Map(feeCounts.map((r) => [r.id, r.n]));
  return rows.map((r) => ({
    ...r,
    eventCount: byEvent.get(r.id) ?? 0,
    feeCount: byFee.get(r.id) ?? 0,
  }));
}

/** Number of events and fees referencing a tax rate. */
export async function taxRateUsage(
  db: Executor,
  taxRateId: string,
): Promise<{ eventCount: number; feeCount: number }> {
  const [[e], [f]] = await Promise.all([
    db.select({ n: count() }).from(events).where(eq(events.taxRateId, taxRateId)),
    db.select({ n: count() }).from(fees).where(eq(fees.taxRateId, taxRateId)),
  ]);
  return { eventCount: e?.n ?? 0, feeCount: f?.n ?? 0 };
}

/** Clears the default flag of every other rate (exactly one default, partial unique index). */
async function clearOtherDefaults(tx: Executor, keepId: string | null): Promise<void> {
  await tx
    .update(taxRates)
    .set({ isDefault: false })
    .where(and(eq(taxRates.isDefault, true), ...(keepId ? [ne(taxRates.id, keepId)] : [])));
}

export async function createTaxRate(db: Executor, input: TaxRateInput): Promise<TaxRateRow> {
  const data = parseInput(input);
  return db
    .transaction(async (tx) => {
      if (data.isDefault) await clearOtherDefaults(tx, null);
      const [row] = await tx
        .insert(taxRates)
        .values({ ...rowValues(data), archivedAt: data.isActive ? null : new Date() })
        .returning();
      return row!;
    })
    .catch(nameTaken);
}

export async function updateTaxRate(
  db: Executor,
  taxRateId: string,
  input: TaxRateInput,
): Promise<{ before: TaxRateRow; after: TaxRateRow }> {
  const data = parseInput(input);
  return db
    .transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(taxRates)
        .where(eq(taxRates.id, taxRateId))
        .for('update');
      if (!before) throw new DomainError('TAX_RATE_NOT_FOUND', 'Tax rate not found', 404);
      if (data.isDefault) await clearOtherDefaults(tx, taxRateId);
      const archivedAt = data.isActive ? null : (before.archivedAt ?? new Date());
      const [after] = await tx
        .update(taxRates)
        .set({ ...rowValues(data), archivedAt })
        .where(eq(taxRates.id, taxRateId))
        .returning();
      return { before, after: after! };
    })
    .catch(nameTaken);
}

/**
 * Deletes an unused tax rate. Rates referenced by events or fees are refused with
 * `TAX_RATE_IN_USE` (deactivate them instead); past orders keep their own snapshot.
 */
export async function deleteTaxRate(db: Executor, taxRateId: string): Promise<TaxRateRow> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(taxRates)
        .where(eq(taxRates.id, taxRateId))
        .for('update');
      if (!row) throw new DomainError('TAX_RATE_NOT_FOUND', 'Tax rate not found', 404);
      const usage = await taxRateUsage(tx, taxRateId);
      if (usage.eventCount > 0 || usage.feeCount > 0) {
        throw new DomainError(
          'TAX_RATE_IN_USE',
          'The tax rate is used by events or fees',
          409,
          usage,
        );
      }
      await tx.delete(taxRates).where(eq(taxRates.id, taxRateId));
      return row;
    });
  } catch (err) {
    // An event / fee started using the rate concurrently (ON DELETE RESTRICT).
    const code = findPgError(err)?.code;
    if (code === PG_ERROR.FOREIGN_KEY_VIOLATION || code === PG_ERROR.RESTRICT_VIOLATION) {
      throw new DomainError('TAX_RATE_IN_USE', 'The tax rate is used by events or fees', 409);
    }
    throw err;
  }
}
