import 'server-only';
import {
  adminUsers,
  bankAccounts,
  bankConnections,
  bankStatementImports,
  bankSyncRuns,
  bankTanChallenges,
  bankTransactionAllocations,
  bankTransactions,
  orders,
} from '@tix/db';
import {
  BANK_TX_MATCH_STATUSES,
  BANK_TX_REVIEW_REASONS,
  type BankTxMatchStatus,
  type BankTxReviewReason,
  type MatchCandidate,
} from '@tix/shared';
import { and, count, desc, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { ReviewCaseView } from '@/components/admin/banking/review-case';
import { getCore } from '@/server/core';

/** Data loaders of the Banking & Vorkasse center (Admin Portal). */

export type BankAccountRow = typeof bankAccounts.$inferSelect;
export type BankConnectionRow = typeof bankConnections.$inferSelect;

export async function listBankAccounts() {
  const { db } = getCore();
  // Drizzle renders columns unqualified in a single-table select, so the outer column is spelled out.
  const connectionCount = sql<number>`(SELECT count(*)::int FROM ${bankConnections} WHERE ${bankConnections.bankAccountId} = "bank_accounts"."id")`;
  return db
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      accountHolder: bankAccounts.accountHolder,
      iban: bankAccounts.iban,
      bic: bankAccounts.bic,
      bankName: bankAccounts.bankName,
      currency: bankAccounts.currency,
      isDefaultForBankTransfer: bankAccounts.isDefaultForBankTransfer,
      isActive: bankAccounts.isActive,
      connections: connectionCount,
    })
    .from(bankAccounts)
    .orderBy(desc(bankAccounts.isDefaultForBankTransfer), bankAccounts.name);
}

export async function getBankAccount(id: string) {
  const { db } = getCore();
  const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id));
  if (!account) return null;
  const connections = await db
    .select()
    .from(bankConnections)
    .where(eq(bankConnections.bankAccountId, id))
    .orderBy(bankConnections.createdAt);
  return { account, connections };
}

/** Connections with their account (status overview, upload targets). */
export async function listConnections() {
  const { db } = getCore();
  return db
    .select({
      connection: bankConnections,
      accountName: bankAccounts.name,
      iban: bankAccounts.iban,
    })
    .from(bankConnections)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankConnections.bankAccountId))
    .orderBy(bankAccounts.name, bankConnections.name);
}

export type PendingChallenge = typeof bankTanChallenges.$inferSelect & {
  connectionName: string;
};

export async function pendingTanChallenges(connectionId?: string): Promise<PendingChallenge[]> {
  const { db } = getCore();
  const rows = await db
    .select({ challenge: bankTanChallenges, connectionName: bankConnections.name })
    .from(bankTanChallenges)
    .innerJoin(bankConnections, eq(bankConnections.id, bankTanChallenges.connectionId))
    .where(
      and(
        inArray(bankTanChallenges.status, ['PENDING', 'SUBMITTED']),
        sql`${bankTanChallenges.expiresAt} > now()`,
        connectionId ? eq(bankTanChallenges.connectionId, connectionId) : undefined,
      ),
    )
    .orderBy(desc(bankTanChallenges.createdAt));
  return rows.map((r) => ({ ...r.challenge, connectionName: r.connectionName }));
}

export async function getConnectionDetail(id: string) {
  const { db } = getCore();
  const [row] = await db
    .select({ connection: bankConnections, account: bankAccounts })
    .from(bankConnections)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankConnections.bankAccountId))
    .where(eq(bankConnections.id, id));
  if (!row) return null;
  const [runs, challenges, imports] = await Promise.all([
    db
      .select()
      .from(bankSyncRuns)
      .where(eq(bankSyncRuns.connectionId, id))
      .orderBy(desc(bankSyncRuns.startedAt))
      .limit(25),
    pendingTanChallenges(id),
    db
      .select()
      .from(bankStatementImports)
      .where(eq(bankStatementImports.connectionId, id))
      .orderBy(desc(bankStatementImports.createdAt))
      .limit(10),
  ]);
  return { ...row, runs, challenges, imports };
}

export async function bankingStats() {
  const { db } = getCore();
  const rows = await db
    .select({
      status: bankTransactions.matchStatus,
      n: count(),
      sum: sql<number>`coalesce(sum(${bankTransactions.amount}), 0)::bigint`,
    })
    .from(bankTransactions)
    .where(sql`${bankTransactions.amount} > 0`)
    .groupBy(bankTransactions.matchStatus);
  const by = Object.fromEntries(rows.map((r) => [r.status, { n: r.n, sum: Number(r.sum) }]));
  const [recent] = await db
    .select({ n: count() })
    .from(bankTransactions)
    .where(
      and(
        inArray(bankTransactions.matchStatus, ['AUTO_MATCHED', 'MANUALLY_MATCHED']),
        gte(bankTransactions.updatedAt, sql`now() - interval '30 days'`),
      ),
    );
  return {
    review: by.NEEDS_REVIEW?.n ?? 0,
    reviewSum: by.NEEDS_REVIEW?.sum ?? 0,
    unmatched: by.UNMATCHED?.n ?? 0,
    autoMatched: by.AUTO_MATCHED?.n ?? 0,
    manuallyMatched: by.MANUALLY_MATCHED?.n ?? 0,
    matchedLast30Days: recent?.n ?? 0,
  };
}

export interface TransactionFilters {
  status?: BankTxMatchStatus;
  reason?: BankTxReviewReason;
  accountId?: string;
  from?: string;
  to?: string;
  q?: string;
  direction?: 'in' | 'out';
}

function transactionWhere(f: TransactionFilters): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    f.status ? eq(bankTransactions.matchStatus, f.status) : undefined,
    f.reason ? eq(bankTransactions.reviewReason, f.reason) : undefined,
    f.accountId ? eq(bankTransactions.bankAccountId, f.accountId) : undefined,
    f.from ? gte(bankTransactions.bookingDate, f.from) : undefined,
    f.to ? lte(bankTransactions.bookingDate, f.to) : undefined,
    f.direction === 'in' ? sql`${bankTransactions.amount} > 0` : undefined,
    f.direction === 'out' ? lt(bankTransactions.amount, 0) : undefined,
  ];
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const compact = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    conditions.push(
      or(
        ilike(bankTransactions.counterpartyName, like),
        ilike(bankTransactions.remittanceInformation, like),
        ilike(bankTransactions.counterpartyIban, `%${compact}%`),
        ilike(bankTransactions.endToEndId, like),
        ...(compact.length >= 4
          ? [sql`replace(${bankTransactions.extractedReference}, '-', '') LIKE ${`%${compact}%`}`]
          : []),
      ),
    );
  }
  const defined = conditions.filter((c): c is SQL => c !== undefined);
  return defined.length > 0 ? and(...defined) : undefined;
}

export async function listTransactions(
  filters: TransactionFilters,
  page: number,
  pageSize: number,
) {
  const { db } = getCore();
  const where = transactionWhere(filters);
  const [rows, [total]] = await Promise.all([
    db
      .select({ tx: bankTransactions, accountName: bankAccounts.name })
      .from(bankTransactions)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
      .where(where)
      .orderBy(desc(bankTransactions.bookingDate), desc(bankTransactions.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(bankTransactions).where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
}

/** Rows for the CSV export (bounded). */
export async function exportTransactions(filters: TransactionFilters, limit = 50_000) {
  const { db } = getCore();
  return db
    .select({ tx: bankTransactions, accountName: bankAccounts.name, iban: bankAccounts.iban })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
    .where(transactionWhere(filters))
    .orderBy(bankTransactions.bookingDate, bankTransactions.createdAt)
    .limit(limit);
}

export interface CandidateOrder {
  id: string;
  orderNumber: string;
  status: string;
  name: string;
  email: string | null;
  paymentReference: string | null;
  totalGross: number;
  amountPaid: number;
  currency: string;
}

async function ordersById(ids: string[]): Promise<Map<string, CandidateOrder>> {
  if (ids.length === 0) return new Map();
  const { db } = getCore();
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      firstName: orders.firstName,
      lastName: orders.lastName,
      company: orders.company,
      email: orders.email,
      paymentReference: orders.paymentReference,
      totalGross: orders.totalGross,
      amountPaid: orders.amountPaid,
      currency: orders.currency,
    })
    .from(orders)
    .where(inArray(orders.id, ids));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        orderNumber: r.orderNumber,
        status: r.status,
        name: [`${r.firstName} ${r.lastName}`.trim(), r.company].filter(Boolean).join(' · '),
        email: r.email,
        paymentReference: r.paymentReference,
        totalGross: r.totalGross,
        amountPaid: r.amountPaid,
        currency: r.currency,
      },
    ]),
  );
}

export interface AllocationView {
  id: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  method: string;
  note: string | null;
  createdAt: Date;
  reversedAt: Date | null;
  reversedBy: string | null;
  reversalReason: string | null;
}

async function allocationsFor(transactionIds: string[]): Promise<Map<string, AllocationView[]>> {
  const map = new Map<string, AllocationView[]>();
  if (transactionIds.length === 0) return map;
  const { db } = getCore();
  const rows = await db
    .select({
      id: bankTransactionAllocations.id,
      transactionId: bankTransactionAllocations.bankTransactionId,
      orderId: bankTransactionAllocations.orderId,
      orderNumber: orders.orderNumber,
      amount: bankTransactionAllocations.amount,
      method: bankTransactionAllocations.method,
      note: bankTransactionAllocations.note,
      createdAt: bankTransactionAllocations.createdAt,
      reversedAt: bankTransactionAllocations.reversedAt,
      reversedBy: adminUsers.displayName,
      reversalReason: bankTransactionAllocations.reversalReason,
    })
    .from(bankTransactionAllocations)
    .innerJoin(orders, eq(orders.id, bankTransactionAllocations.orderId))
    .leftJoin(adminUsers, eq(adminUsers.id, bankTransactionAllocations.reversedByUserId))
    .where(inArray(bankTransactionAllocations.bankTransactionId, transactionIds))
    .orderBy(bankTransactionAllocations.createdAt);
  for (const { transactionId, ...rest } of rows) {
    map.set(transactionId, [...(map.get(transactionId) ?? []), rest]);
  }
  return map;
}

export interface ReviewCase {
  tx: typeof bankTransactions.$inferSelect;
  accountName: string;
  candidates: (MatchCandidate & { order: CandidateOrder | null })[];
  allocations: AllocationView[];
  unassigned: number;
}

async function enrich(
  rows: { tx: typeof bankTransactions.$inferSelect; accountName: string }[],
): Promise<ReviewCase[]> {
  const candidateIds = [
    ...new Set(rows.flatMap((r) => (r.tx.matchCandidates ?? []).map((c) => c.orderId))),
  ];
  const [orderMap, allocationMap] = await Promise.all([
    ordersById(candidateIds),
    allocationsFor(rows.map((r) => r.tx.id)),
  ]);
  return rows.map((r) => {
    const allocations = allocationMap.get(r.tx.id) ?? [];
    const assigned = allocations.filter((a) => !a.reversedAt).reduce((s, a) => s + a.amount, 0);
    return {
      tx: r.tx,
      accountName: r.accountName,
      candidates: (r.tx.matchCandidates ?? []).map((c) => ({
        ...c,
        order: orderMap.get(c.orderId) ?? null,
      })),
      allocations,
      unassigned: Math.max(0, r.tx.amount - assigned),
    };
  });
}

export async function listReviewCases(
  filters: { reason?: BankTxReviewReason; accountId?: string },
  page: number,
  pageSize: number,
) {
  const { db } = getCore();
  const where = and(
    eq(bankTransactions.matchStatus, 'NEEDS_REVIEW'),
    filters.reason ? eq(bankTransactions.reviewReason, filters.reason) : undefined,
    filters.accountId ? eq(bankTransactions.bankAccountId, filters.accountId) : undefined,
  );
  const [rows, [total], reasons] = await Promise.all([
    db
      .select({ tx: bankTransactions, accountName: bankAccounts.name })
      .from(bankTransactions)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
      .where(where)
      .orderBy(desc(bankTransactions.bookingDate), desc(bankTransactions.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(bankTransactions).where(where),
    db
      .select({ reason: bankTransactions.reviewReason, n: count() })
      .from(bankTransactions)
      .where(eq(bankTransactions.matchStatus, 'NEEDS_REVIEW'))
      .groupBy(bankTransactions.reviewReason),
  ]);
  return {
    cases: await enrich(rows),
    total: total?.n ?? 0,
    reasons: Object.fromEntries(reasons.map((r) => [r.reason ?? '', r.n])) as Record<
      string,
      number
    >,
  };
}

export async function getTransactionDetail(id: string) {
  const { db } = getCore();
  const [row] = await db
    .select({
      tx: bankTransactions,
      accountName: bankAccounts.name,
      importFile: bankStatementImports.fileName,
      importId: bankStatementImports.id,
      runTrigger: bankSyncRuns.trigger,
      connectionName: bankConnections.name,
    })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
    .leftJoin(bankStatementImports, eq(bankStatementImports.id, bankTransactions.importId))
    .leftJoin(bankSyncRuns, eq(bankSyncRuns.id, bankTransactions.syncRunId))
    .leftJoin(bankConnections, eq(bankConnections.id, bankSyncRuns.connectionId))
    .where(eq(bankTransactions.id, id));
  if (!row) return null;
  const [reviewCase] = await enrich([{ tx: row.tx, accountName: row.accountName }]);
  return {
    ...reviewCase!,
    importFile: row.importFile,
    importId: row.importId,
    connectionName: row.connectionName,
  };
}

export async function listImports(page: number, pageSize: number, accountId?: string) {
  const { db } = getCore();
  const where = accountId ? eq(bankStatementImports.bankAccountId, accountId) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select({ file: bankStatementImports, accountName: bankAccounts.name })
      .from(bankStatementImports)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatementImports.bankAccountId))
      .where(where)
      .orderBy(desc(bankStatementImports.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(bankStatementImports).where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
}

/** Accounts selectable for uploads (active), with their file-import connection (CSV profile). */
export async function uploadTargets() {
  const { db } = getCore();
  const accounts = await db
    .select({ id: bankAccounts.id, name: bankAccounts.name, iban: bankAccounts.iban })
    .from(bankAccounts)
    .where(eq(bankAccounts.isActive, true))
    .orderBy(desc(bankAccounts.isDefaultForBankTransfer), bankAccounts.name);
  return accounts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses list filters from URL search params (invalid values are dropped). */
export function parseTransactionFilters(
  sp: Record<string, string | string[] | undefined>,
): TransactionFilters {
  const one = (key: string) => {
    const v = sp[key];
    return typeof v === 'string' ? v : undefined;
  };
  const status = one('status');
  const reason = one('reason');
  const direction = one('direction');
  return {
    status: (BANK_TX_MATCH_STATUSES as readonly string[]).includes(status ?? '')
      ? (status as BankTxMatchStatus)
      : undefined,
    reason: (BANK_TX_REVIEW_REASONS as readonly string[]).includes(reason ?? '')
      ? (reason as BankTxReviewReason)
      : undefined,
    accountId: UUID.test(one('account') ?? '') ? one('account') : undefined,
    from: ISO_DATE.test(one('from') ?? '') ? one('from') : undefined,
    to: ISO_DATE.test(one('to') ?? '') ? one('to') : undefined,
    q: one('q')?.slice(0, 100) || undefined,
    direction: direction === 'in' || direction === 'out' ? direction : undefined,
  };
}

/** Order numbers per transaction (active allocations) for lists and exports. */
export async function allocatedOrderNumbers(
  transactionIds: string[],
): Promise<Map<string, string[]>> {
  const map = await allocationsFor(transactionIds);
  return new Map(
    [...map.entries()].map(([id, list]) => [
      id,
      list.filter((a) => !a.reversedAt).map((a) => a.orderNumber),
    ]),
  );
}

/** Serialisable props for the client `ReviewCase` component. */
export function toReviewCaseView(rc: ReviewCase): ReviewCaseView {
  return {
    id: rc.tx.id,
    bookingDate: rc.tx.bookingDate,
    amount: rc.tx.amount,
    currency: rc.tx.currency,
    counterpartyName: rc.tx.counterpartyName,
    counterpartyIban: rc.tx.counterpartyIban,
    remittanceInformation: rc.tx.remittanceInformation,
    endToEndId: rc.tx.endToEndId,
    extractedReference: rc.tx.extractedReference,
    matchStatus: rc.tx.matchStatus,
    reviewReason: rc.tx.reviewReason,
    reviewNote: rc.tx.reviewNote,
    accountName: rc.accountName,
    candidates: rc.candidates.map((c) => ({
      orderId: c.orderId,
      orderNumber: c.orderNumber,
      score: c.score,
      reasons: c.reasons,
      order: c.order,
    })),
    allocations: rc.allocations.map((a) => ({
      id: a.id,
      orderId: a.orderId,
      orderNumber: a.orderNumber,
      amount: a.amount,
      method: a.method,
      note: a.note,
      reversed: a.reversedAt !== null,
      reversedAt: a.reversedAt?.toISOString() ?? null,
      reversedBy: a.reversedBy,
      reversalReason: a.reversalReason,
    })),
    unassigned: rc.unassigned,
  };
}
