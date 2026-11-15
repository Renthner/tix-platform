import { bankTransactionAllocations, bankTransactions, type Executor } from '@tix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { normalizeForFingerprint } from './fingerprint';

/**
 * "Holds": bank transactions that are stored but must never take part in matching, allocation
 * or auto-fulfilment. They are stored as IGNORED (an existing status, no migration) and carry
 * `raw_data.hold`:
 *  - INTERIM            MT942 entry (interim report, may be a pending credit that is never booked).
 *                       Linked to the final booking via `raw_data.supersededBy` once that arrives.
 *  - POSSIBLE_DUPLICATE camt.054 entry whose fingerprint equals an entry of an earlier camt.054
 *                       file without a reference id that tells the two apart – an admin decides.
 *  - NO_BOOKING_DATE    camt.054 entry without booking date and without a stable reference.
 *  - AGGREGATE          camt.052/053 batch entry already covered by per-transaction camt.054 rows
 *                       (`raw_data.coveredBy`), so the money is counted once.
 * An admin can release POSSIBLE_DUPLICATE / NO_BOOKING_DATE ("rematch"); INTERIM / AGGREGATE rows
 * never become matchable.
 */
export const HOLD_REASONS = [
  'INTERIM',
  'POSSIBLE_DUPLICATE',
  'NO_BOOKING_DATE',
  'AGGREGATE',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Window for linking an interim entry to its final booking (days, either direction). */
export const INTERIM_SUPERSEDE_WINDOW_DAYS = 7;
/** Window for covering an aggregate entry by camt.054 rows (days, either direction). */
const AGGREGATE_WINDOW_DAYS = 3;

export function heldReason(raw: unknown): HoldReason | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const hold = (raw as Record<string, unknown>).hold;
  return typeof hold === 'string' && (HOLD_REASONS as readonly string[]).includes(hold)
    ? (hold as HoldReason)
    : null;
}

/** Holds an admin may release by re-running the matcher. */
export function isReleasableHold(reason: HoldReason | null): boolean {
  return reason === 'POSSIBLE_DUPLICATE' || reason === 'NO_BOOKING_DATE';
}

export function supersededBy(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>).supersededBy;
  return typeof value === 'string' ? value : null;
}

export interface LinkRow {
  id: string;
  amount: number;
  currency: string;
  bookingDate: string;
  counterpartyIban: string | null;
  remittanceInformation: string | null;
  hold: HoldReason | null;
  interim: boolean;
  source: string | null;
  aggregate: boolean;
}

const normIban = (v: string | null | undefined) => (v ?? '').replace(/\s/g, '').toUpperCase();

/** Same remittance text: equal, or one is a prefix (>= 10 chars) of the other. Empty = unknown. */
export function remittanceSimilar(a: string | null, b: string | null): boolean {
  const x = normalizeForFingerprint(a);
  const y = normalizeForFingerprint(b);
  if (!x || !y) return true;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 10 && long.startsWith(short);
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

type RowShape = typeof bankTransactions.$inferSelect;

const rawOf = (row: Pick<RowShape, 'rawData'>): Record<string, unknown> =>
  typeof row.rawData === 'object' && row.rawData !== null
    ? (row.rawData as Record<string, unknown>)
    : {};

function markRaw(
  db: Executor,
  id: string,
  patch: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return db
    .update(bankTransactions)
    .set({
      rawData: sql`coalesce(${bankTransactions.rawData}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      ...extra,
    })
    .where(eq(bankTransactions.id, id));
}

/**
 * Links interim rows and their final bookings (both directions) and covers aggregate entries
 * by per-transaction camt.054 rows. Called after every insert batch; idempotent.
 */
export async function linkHeldRows(
  db: Executor,
  bankAccountId: string,
  inserted: readonly LinkRow[],
  windowDays = INTERIM_SUPERSEDE_WINDOW_DAYS,
): Promise<{ superseded: number; aggregatesCovered: number }> {
  let superseded = 0;
  for (const row of inserted) {
    if (row.amount <= 0) continue;
    if (row.interim) {
      superseded += await supersedeInterimIfFinalExists(db, bankAccountId, row, windowDays);
    } else if (!row.hold || row.hold === 'NO_BOOKING_DATE') {
      superseded += await supersedeInterimOf(db, bankAccountId, row, windowDays);
    }
  }
  const aggregatesCovered = await coverAggregates(db, bankAccountId, inserted);
  return { superseded, aggregatesCovered };
}

async function interimCandidates(
  db: Executor,
  bankAccountId: string,
  row: LinkRow,
  windowDays: number,
  interim: boolean,
) {
  const from = addDays(row.bookingDate, -windowDays);
  const to = addDays(row.bookingDate, windowDays);
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, bankAccountId),
        eq(bankTransactions.amount, row.amount),
        eq(bankTransactions.currency, row.currency),
        sql`${bankTransactions.bookingDate} between ${from} and ${to}`,
        interim
          ? sql`${bankTransactions.rawData}->>'hold' = 'INTERIM' AND ${bankTransactions.rawData}->>'supersededBy' IS NULL`
          : sql`${bankTransactions.rawData}->>'hold' IS NULL AND coalesce(${bankTransactions.rawData}->>'interim', '') <> 'true'`,
      ),
    );
  return rows.filter((c) => c.id !== row.id);
}

function pick(row: LinkRow, candidates: RowShape[]): RowShape | null {
  const sameParty = candidates.filter((c) => {
    const a = normIban(c.counterpartyIban);
    const b = normIban(row.counterpartyIban);
    return !a || !b || a === b;
  });
  const similar = sameParty.filter((c) =>
    remittanceSimilar(c.remittanceInformation, row.remittanceInformation),
  );
  // Changed reference between the interim and the final entry (rebooked): a unique
  // candidate with the same IBAN, amount and window is still the same credit.
  const pool = similar.length > 0 ? similar : sameParty.length === 1 ? sameParty : [];
  if (pool.length === 0) return null;
  return pool.sort(
    (a, b) =>
      dayDistance(a.bookingDate, row.bookingDate) - dayDistance(b.bookingDate, row.bookingDate),
  )[0]!;
}

/** A final booking arrived: mark the matching interim row (if any) as superseded. */
async function supersedeInterimOf(
  db: Executor,
  bankAccountId: string,
  final: LinkRow,
  windowDays: number,
): Promise<number> {
  const candidates = await interimCandidates(db, bankAccountId, final, windowDays, true);
  const chosen = pick(final, candidates);
  if (!chosen) return 0;
  await markRaw(db, chosen.id, { supersededBy: final.id });
  return 1;
}

/** An interim row arrived after its final booking: it is superseded right away. */
async function supersedeInterimIfFinalExists(
  db: Executor,
  bankAccountId: string,
  interim: LinkRow,
  windowDays: number,
): Promise<number> {
  const finals = await interimCandidates(db, bankAccountId, interim, windowDays, false);
  if (finals.length === 0) return 0;
  // A final booking that already superseded another interim row is not available again.
  const claimed = new Set(
    (
      await db
        .select({ by: sql<string>`${bankTransactions.rawData}->>'supersededBy'` })
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.bankAccountId, bankAccountId),
            inArray(
              sql`${bankTransactions.rawData}->>'supersededBy'`,
              finals.map((f) => f.id),
            ),
          ),
        )
    ).map((r) => r.by),
  );
  const chosen = pick(
    interim,
    finals.filter((f) => !claimed.has(f.id)),
  );
  if (!chosen) return 0;
  await markRaw(db, interim.id, { supersededBy: chosen.id });
  return 1;
}

/**
 * camt.052/053 batch entries (one row for many payments) are redundant once the individual
 * camt.054 rows of the same day exist: when those add up to the batch amount the batch row is
 * held (AGGREGATE) so the money is counted once. Never touches rows that carry allocations.
 */
async function coverAggregates(
  db: Executor,
  bankAccountId: string,
  inserted: readonly LinkRow[],
): Promise<number> {
  const relevant = inserted.filter(
    (r) => r.amount > 0 && (r.aggregate || (r.source === 'camt054' && !r.hold)),
  );
  if (relevant.length === 0) return 0;
  const dates = relevant.map((r) => r.bookingDate).sort();
  const from = addDays(dates[0]!, -AGGREGATE_WINDOW_DAYS);
  const to = addDays(dates.at(-1)!, AGGREGATE_WINDOW_DAYS);
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, bankAccountId),
        sql`${bankTransactions.amount} > 0`,
        sql`${bankTransactions.bookingDate} between ${from} and ${to}`,
        sql`${bankTransactions.rawData}->>'hold' IS NULL`,
      ),
    );
  const aggregates = rows.filter((r) => rawOf(r).aggregate === true);
  const singles = rows.filter((r) => rawOf(r).source === 'camt054' && rawOf(r).aggregate !== true);
  let covered = 0;
  for (const agg of aggregates) {
    const near = singles.filter(
      (s) =>
        s.currency === agg.currency &&
        dayDistance(s.bookingDate, agg.bookingDate) <= AGGREGATE_WINDOW_DAYS,
    );
    if (near.length < 2) continue;
    // The exact set is unknown: accept when all rows of that day sum to the batch amount.
    const sameDay = near.filter((s) => s.bookingDate === agg.bookingDate);
    const pool = sameDay.length >= 2 ? sameDay : near;
    if (pool.reduce((sum, s) => sum + s.amount, 0) !== agg.amount) continue;
    const [allocated] = await db
      .select({ id: bankTransactionAllocations.id })
      .from(bankTransactionAllocations)
      .where(
        and(
          eq(bankTransactionAllocations.bankTransactionId, agg.id),
          isNull(bankTransactionAllocations.reversedAt),
        ),
      )
      .limit(1);
    if (allocated) continue;
    await markRaw(
      db,
      agg.id,
      { hold: 'AGGREGATE', coveredBy: pool.map((s) => s.id) },
      { matchStatus: 'IGNORED', reviewReason: null },
    );
    covered += 1;
  }
  return covered;
}
