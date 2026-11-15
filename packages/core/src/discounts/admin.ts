import { discountCodes, isUniqueViolation, orderDiscounts, orders, type Executor } from '@tix/db';
import {
  DISCOUNT_CODE_ALPHABET,
  DISCOUNT_USAGE_ORDER_STATUSES,
  type DiscountBulkInput,
  type DiscountCodeInput,
} from '@tix/shared';
import { and, asc, count, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import { buildCsv, formatCsvAmount, formatCsvPercent, type CsvCell } from '../accounting/csv';
import { DomainError } from '../context';
import { discountUsageCounts, type DiscountCodeRow } from './plan';

/**
 * Administration of discount codes (admin portal "Discount codes"). Every function accepts an
 * executor so the caller can write its audit entry in the same transaction.
 */

export type DiscountCodeStatus = 'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'SCHEDULED' | 'EXHAUSTED';

export interface DiscountCodeListItem extends DiscountCodeRow {
  /** Active uses (non-test orders that are not cancelled / expired / fully refunded). */
  uses: number;
  /** Σ discount of those uses (cents). */
  discountSum: number;
  status: DiscountCodeStatus;
}

const notFound = () => new DomainError('DISCOUNT_CODE_NOT_FOUND', 'Discount code not found', 404);
const taken = () =>
  new DomainError('DISCOUNT_CODE_TAKEN', 'This discount code already exists', 409);

export function discountCodeStatus(
  row: Pick<DiscountCodeRow, 'isActive' | 'validFrom' | 'validUntil' | 'maxTotalUses'>,
  uses: number,
  now = new Date(),
): DiscountCodeStatus {
  if (!row.isActive) return 'INACTIVE';
  if (row.validUntil && row.validUntil <= now) return 'EXPIRED';
  if (row.validFrom && row.validFrom > now) return 'SCHEDULED';
  if (row.maxTotalUses !== null && uses >= row.maxTotalUses) return 'EXHAUSTED';
  return 'ACTIVE';
}

const usageFilter = and(
  eq(orders.isTest, false),
  inArray(orders.status, [...DISCOUNT_USAGE_ORDER_STATUSES]),
);

async function discountSums(db: Executor, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: orderDiscounts.discountCodeId,
      sum: sql<number>`sum(${orderDiscounts.amount})::int`,
    })
    .from(orderDiscounts)
    .innerJoin(orders, eq(orders.id, orderDiscounts.orderId))
    .where(and(inArray(orderDiscounts.discountCodeId, ids), usageFilter))
    .groupBy(orderDiscounts.discountCodeId);
  for (const r of rows) out.set(r.id, r.sum);
  return out;
}

async function withUsage(db: Executor, rows: DiscountCodeRow[]): Promise<DiscountCodeListItem[]> {
  const ids = rows.map((r) => r.id);
  const [{ total }, sums] = await Promise.all([
    discountUsageCounts(db, ids),
    discountSums(db, ids),
  ]);
  return rows.map((row) => {
    const uses = total.get(row.id) ?? 0;
    return {
      ...row,
      uses,
      discountSum: sums.get(row.id) ?? 0,
      status: discountCodeStatus(row, uses),
    };
  });
}

export async function listDiscountCodes(
  db: Executor,
  query: { q?: string; batchId?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: DiscountCodeListItem[]; total: number }> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const filters: SQL[] = [];
  const q = query.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    filters.push(
      sql`(${ilike(discountCodes.code, pattern)} OR ${ilike(sql`coalesce(${discountCodes.note}, '')`, pattern)})`,
    );
  }
  if (query.batchId) filters.push(eq(discountCodes.batchId, query.batchId));
  const where = filters.length ? and(...filters) : undefined;
  const [totalRow] = await db.select({ n: count() }).from(discountCodes).where(where);
  const rows = await db
    .select()
    .from(discountCodes)
    .where(where)
    .orderBy(desc(discountCodes.createdAt), asc(discountCodes.code))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: await withUsage(db, rows), total: totalRow?.n ?? 0 };
}

export async function getDiscountCode(
  db: Executor,
  id: string,
): Promise<DiscountCodeListItem | null> {
  const [row] = await db.select().from(discountCodes).where(eq(discountCodes.id, id));
  if (!row) return null;
  return (await withUsage(db, [row]))[0]!;
}

function values(input: Omit<DiscountCodeInput, 'code'>) {
  return {
    type: input.type,
    value: input.value,
    allEvents: input.allEvents,
    eventIds: input.allEvents ? [] : input.eventIds,
    categoryIds: input.categoryIds,
    ticketTypeIds: input.ticketTypeIds,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    maxTotalUses: input.maxTotalUses,
    maxUsesPerEmail: input.maxUsesPerEmail,
    minOrderValue: input.minOrderValue,
    discountFees: input.discountFees,
    stackable: input.stackable,
    isActive: input.isActive,
    note: input.note ? input.note : null,
  };
}

export async function createDiscountCode(
  db: Executor,
  input: DiscountCodeInput,
  userId: string | null,
): Promise<DiscountCodeRow> {
  try {
    const [row] = await db
      .insert(discountCodes)
      .values({ code: input.code, ...values(input), createdByUserId: userId })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, 'discount_codes_code_uq')) throw taken();
    throw err;
  }
}

/** Updates the settings of a code (the code itself never changes: orders and mails quote it). */
export async function updateDiscountCode(
  db: Executor,
  id: string,
  input: Omit<DiscountCodeInput, 'code'>,
): Promise<{ before: DiscountCodeRow; after: DiscountCodeRow }> {
  const [before] = await db
    .select()
    .from(discountCodes)
    .where(eq(discountCodes.id, id))
    .for('update');
  if (!before) throw notFound();
  const [after] = await db
    .update(discountCodes)
    .set(values(input))
    .where(eq(discountCodes.id, id))
    .returning();
  return { before, after: after! };
}

export async function setDiscountCodeActive(
  db: Executor,
  id: string,
  isActive: boolean,
): Promise<DiscountCodeRow> {
  const [row] = await db
    .update(discountCodes)
    .set({ isActive })
    .where(eq(discountCodes.id, id))
    .returning();
  if (!row) throw notFound();
  return row;
}

/** Only codes that no order ever used can be deleted (otherwise deactivate them). */
export async function deleteDiscountCode(db: Executor, id: string): Promise<DiscountCodeRow> {
  const [row] = await db.select().from(discountCodes).where(eq(discountCodes.id, id)).for('update');
  if (!row) throw notFound();
  const [used] = await db
    .select({ n: count() })
    .from(orderDiscounts)
    .where(eq(orderDiscounts.discountCodeId, id));
  if ((used?.n ?? 0) > 0) {
    throw new DomainError(
      'DISCOUNT_CODE_USED',
      'This code was used by orders – deactivate it instead',
      409,
    );
  }
  await db.delete(discountCodes).where(eq(discountCodes.id, id));
  return row;
}

const randomPart = (length: number) =>
  Array.from(
    { length },
    () => DISCOUNT_CODE_ALPHABET[randomInt(DISCOUNT_CODE_ALPHABET.length)],
  ).join('');

/**
 * Bulk generation: `count` random single-use codes (`PREFIX-XXXXXXXX`, alphabet without
 * look-alike characters) with the same settings, all tagged with one `batch_id` for the CSV export.
 */
export async function createDiscountCodesBulk(
  db: Executor,
  input: DiscountBulkInput,
  userId: string | null,
): Promise<{ batchId: string; codes: string[] }> {
  const batchId = randomUUID();
  const base = {
    ...values({ ...input, note: input.note }),
    // One use per code: that is what makes a bulk code a "voucher".
    maxTotalUses: 1,
    batchId,
    createdByUserId: userId,
  };
  const prefix = input.prefix ? `${input.prefix}-` : '';
  const created: string[] = [];
  for (let round = 0; round < 8 && created.length < input.count; round += 1) {
    const wanted = input.count - created.length;
    const candidates = [
      ...new Set(Array.from({ length: wanted }, () => `${prefix}${randomPart(8)}`)),
    ];
    const inserted = await db
      .insert(discountCodes)
      .values(candidates.map((code) => ({ ...base, code })))
      .onConflictDoNothing()
      .returning({ code: discountCodes.code });
    created.push(...inserted.map((r) => r.code));
  }
  if (created.length < input.count) {
    throw new DomainError(
      'DISCOUNT_BULK_INCOMPLETE',
      'Could not generate enough unique codes',
      409,
    );
  }
  return { batchId, codes: created };
}

export interface DiscountUsageRow {
  orderId: string;
  orderNumber: string;
  status: string;
  email: string | null;
  isTest: boolean;
  /** Counts against the limits (active, non-test order). */
  counted: boolean;
  amount: number;
  feeAmount: number;
  orderTotal: number;
  createdAt: Date;
}

export async function listDiscountUsages(
  db: Executor,
  codeId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ rows: DiscountUsageRow[]; total: number }> {
  const [totalRow] = await db
    .select({ n: count() })
    .from(orderDiscounts)
    .where(eq(orderDiscounts.discountCodeId, codeId));
  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      email: orders.email,
      isTest: orders.isTest,
      amount: orderDiscounts.amount,
      feeAmount: orderDiscounts.feeAmount,
      orderTotal: orders.totalGross,
      createdAt: orders.createdAt,
    })
    .from(orderDiscounts)
    .innerJoin(orders, eq(orders.id, orderDiscounts.orderId))
    .where(eq(orderDiscounts.discountCodeId, codeId))
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(options.limit ?? 100, 500))
    .offset(options.offset ?? 0);
  return {
    total: totalRow?.n ?? 0,
    rows: rows.map((r) => ({
      ...r,
      counted: !r.isTest && (DISCOUNT_USAGE_ORDER_STATUSES as readonly string[]).includes(r.status),
    })),
  };
}

/** CSV of codes (all, or one bulk batch) for printing / distribution: `;`-separated, Excel-ready. */
export async function exportDiscountCodesCsv(
  db: Executor,
  filter: { batchId?: string } = {},
  labels: { header: string[]; types: Record<'FIXED' | 'PERCENT', string>; yes: string; no: string },
  timeZone = 'UTC',
): Promise<{ csv: string; rows: number }> {
  const rows = await db
    .select()
    .from(discountCodes)
    .where(filter.batchId ? eq(discountCodes.batchId, filter.batchId) : undefined)
    .orderBy(asc(discountCodes.createdAt), asc(discountCodes.code));
  const items = await withUsage(db, rows);
  const date = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat('sv-SE', {
          timeZone,
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(d)
      : '';
  const body: CsvCell[][] = items.map((c) => [
    c.code,
    labels.types[c.type],
    c.type === 'PERCENT' ? formatCsvPercent(c.value) : formatCsvAmount(c.value),
    date(c.validFrom),
    date(c.validUntil),
    c.maxTotalUses,
    c.maxUsesPerEmail,
    c.minOrderValue === null ? null : formatCsvAmount(c.minOrderValue),
    c.discountFees ? labels.yes : labels.no,
    c.stackable ? labels.yes : labels.no,
    c.uses,
    formatCsvAmount(c.discountSum),
    c.status,
    c.note,
  ]);
  return { csv: buildCsv(labels.header, body), rows: body.length };
}
