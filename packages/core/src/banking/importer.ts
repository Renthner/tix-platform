import { createHash } from 'node:crypto';
import { bankStatementImports, bankTransactions } from '@tix/db';
import {
  accountIdentifierMatchesIban,
  csvProfileSchema,
  type BankImportSource,
  type BankStatementFormat,
  type CsvProfile,
  type StatementFormatHint,
} from '@tix/shared';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { requireCapability, type CoreContext } from '../context';
import type { BankAccountRow } from './connections';
import { fingerprintBatch } from './fingerprint';
import { coreLog } from '../log';
import { linkHeldRows, type HoldReason, type LinkRow } from './holds';
import {
  detectStatementFormat,
  expandStatementFiles,
  parseStatementFile,
  type StatementSource,
} from './parsers';
import { decodeText } from './text';
import { StatementParseError, type ParsedTransaction } from './types';

/** Upper bound for one uploaded / mailed statement file. */
export const MAX_STATEMENT_FILE_BYTES = 20 * 1024 * 1024;
const INSERT_CHUNK = 500;

/**
 * A TRUSTED import of a transaction that already exists as an untrusted (forged-mail) row clears
 * the `untrustedSource` flag, otherwise a forged mail sent first would keep the real booking out
 * of auto-matching forever. Returns the ids the matcher should look at again (credits that are
 * still open and not held).
 */
async function promoteTrustedRows(
  ctx: Pick<CoreContext, 'db'>,
  bankAccountId: string,
  where: { fingerprints: string[] } | { importId: string },
): Promise<string[]> {
  const scope =
    'fingerprints' in where
      ? where.fingerprints.length > 0
        ? inArray(bankTransactions.fingerprint, where.fingerprints)
        : undefined
      : eq(bankTransactions.importId, where.importId);
  if (!scope) return [];
  const rows = await ctx.db
    .update(bankTransactions)
    .set({ rawData: sql`${bankTransactions.rawData} - 'untrustedSource'` })
    .where(
      and(
        eq(bankTransactions.bankAccountId, bankAccountId),
        scope,
        sql`${bankTransactions.rawData}->>'untrustedSource' = 'true'`,
      ),
    )
    .returning({
      id: bankTransactions.id,
      amount: bankTransactions.amount,
      matchStatus: bankTransactions.matchStatus,
      rawData: bankTransactions.rawData,
    });
  if (rows.length > 0) {
    coreLog.warn(
      { bankAccountId, count: rows.length },
      '[banking] trusted import cleared untrustedSource on existing transactions',
    );
  }
  return rows
    .filter(
      (r) =>
        r.amount > 0 &&
        (r.matchStatus === 'UNMATCHED' || r.matchStatus === 'NEEDS_REVIEW') &&
        !heldReasonOf(r.rawData),
    )
    .map((r) => r.id);
}

function heldReasonOf(raw: unknown): boolean {
  return (
    typeof raw === 'object' && raw !== null && !!(raw as { hold?: unknown }).hold
  );
}

export interface StoredBatch {
  /** Ids of newly inserted transactions that the matcher may act on (credits, not held). */
  insertedIds: string[];
  fetched: number;
  duplicates: number;
  /** Rows stored but held back from matching, per reason (see `holds.ts`). */
  held: Partial<Record<HoldReason, number>>;
  /** Interim rows linked to a final booking by this batch. */
  superseded: number;
  /** Aggregate (batch) entries covered by per-transaction camt.054 rows. */
  aggregatesCovered: number;
}

const isCamtFamily = (source: unknown) => source === 'camt' || source === 'camt054';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Bank/end-to-end reference that identifies one entry (camt family). */
function stableIds(row: { externalId: string | null; endToEndId: string | null }): {
  ref: string | null;
  e2e: string | null;
} {
  return {
    ref: row.externalId?.slice(0, 200) || null,
    e2e: row.endToEndId?.slice(0, 200) || null,
  };
}

const iban = (v: string | null | undefined) => (v ?? '').replace(/\s/g, '').toUpperCase();

/**
 * Secondary duplicate key within the camt family. An AcctSvcrRef identifies the entry on its
 * own (+ amount, currency, IBAN, detail index); an EndToEndId alone is reused by standing
 * orders, so it additionally needs the same booking date.
 */
function secondaryKey(row: {
  externalId: string | null;
  endToEndId: string | null;
  amount: number;
  currency: string;
  counterpartyIban: string | null;
  bookingDate: string;
  detailIndex: unknown;
}): string | null {
  const { ref, e2e } = stableIds(row);
  const tail = `${row.amount}|${row.currency}|${iban(row.counterpartyIban)}|${String(row.detailIndex ?? '')}`;
  if (ref) return `ref|${ref}|${tail}`;
  if (e2e) return `e2e|${e2e}|${row.bookingDate}|${tail}`;
  return null;
}

/**
 * Inserts parsed transactions; rows whose fingerprint already exists for the account are
 * skipped (ON CONFLICT DO NOTHING). Debits are stored as IGNORED – only credits are
 * reconciled.
 *
 * Additional rules (no schema change, existing fingerprints are never altered):
 *  - MT942 (interim) entries get their own fingerprint namespace and are stored held
 *    (INTERIM): never matched; superseded by the final booking when it arrives.
 *  - camt family: before inserting, an entry with the same AcctSvcrRef (or EndToEndId + date)
 *    + amount + IBAN as a row of an earlier import is a duplicate.
 *  - camt.054: an entry whose fingerprint equals one of an *earlier camt.054 file* is a
 *    separate payment when both carry different references, otherwise it is stored held as
 *    POSSIBLE_DUPLICATE and reported (a re-import of the same file/message is caught earlier).
 *  - camt.054 without booking date and without any reference is held (NO_BOOKING_DATE).
 */
export async function storeTransactions(
  ctx: Pick<CoreContext, 'db'>,
  params: {
    bankAccountId: string;
    importId?: string | null;
    syncRunId?: string | null;
    transactions: readonly ParsedTransaction[];
    interimWindowDays?: number;
    /** false = origin not authenticated: rows are never auto-matched (see `matching.ts`). */
    trusted?: boolean;
  },
): Promise<StoredBatch> {
  const txs = params.transactions;
  const fingerprints = fingerprintBatch(txs);
  const sourceOf = (tx: ParsedTransaction) => tx.raw?.source;
  const detailOf = (tx: ParsedTransaction) => tx.raw?.detailIndex;

  // Look up earlier camt rows (secondary key + fingerprint collisions of camt.054 rows).
  type Existing = {
    id: string;
    fingerprint: string;
    importId: string | null;
    externalId: string | null;
    endToEndId: string | null;
    amount: number;
    currency: string;
    counterpartyIban: string | null;
    bookingDate: string;
    source: unknown;
    detailIndex: unknown;
  };
  const camtIndexes = txs.map((tx, i) => i).filter((i) => isCamtFamily(sourceOf(txs[i]!)));
  const bySecondary = new Map<string, Existing>();
  const byFingerprint = new Map<string, Existing>();
  const existingCols = {
    id: bankTransactions.id,
    fingerprint: bankTransactions.fingerprint,
    importId: bankTransactions.importId,
    externalId: bankTransactions.externalId,
    endToEndId: bankTransactions.endToEndId,
    amount: bankTransactions.amount,
    currency: bankTransactions.currency,
    counterpartyIban: bankTransactions.counterpartyIban,
    bookingDate: bankTransactions.bookingDate,
    raw: bankTransactions.rawData,
  };
  const toExisting = (r: {
    id: string;
    fingerprint: string;
    importId: string | null;
    externalId: string | null;
    endToEndId: string | null;
    amount: number;
    currency: string;
    counterpartyIban: string | null;
    bookingDate: string;
    raw: unknown;
  }): Existing => {
    const raw = (typeof r.raw === 'object' && r.raw ? r.raw : {}) as Record<string, unknown>;
    return { ...r, source: raw.source, detailIndex: raw.detailIndex };
  };
  for (let i = 0; i < camtIndexes.length; i += INSERT_CHUNK) {
    const slice = camtIndexes.slice(i, i + INSERT_CHUNK);
    const refs = [...new Set(slice.map((k) => txs[k]!.externalId).filter((v): v is string => !!v))];
    const e2es = [...new Set(slice.map((k) => txs[k]!.endToEndId).filter((v): v is string => !!v))];
    const fps = slice.filter((k) => sourceOf(txs[k]!) === 'camt054').map((k) => fingerprints[k]!);
    const conditions = [
      refs.length ? inArray(bankTransactions.externalId, refs) : undefined,
      e2es.length ? inArray(bankTransactions.endToEndId, e2es) : undefined,
      fps.length ? inArray(bankTransactions.fingerprint, fps) : undefined,
    ].filter((c): c is NonNullable<typeof c> => !!c);
    if (conditions.length === 0) continue;
    const rows = await ctx.db
      .select(existingCols)
      .from(bankTransactions)
      .where(and(eq(bankTransactions.bankAccountId, params.bankAccountId), or(...conditions)));
    for (const r of rows) {
      const ex = toExisting(r);
      if (isCamtFamily(ex.source)) {
        const key = secondaryKey(ex);
        if (key && !bySecondary.has(key)) bySecondary.set(key, ex);
      }
      byFingerprint.set(ex.fingerprint, ex);
    }
  }

  interface Plan {
    skip: boolean;
    fingerprint: string;
    hold: HoldReason | null;
  }
  const plans: Plan[] = txs.map((tx, i) => {
    let fingerprint = fingerprints[i]!;
    let hold: HoldReason | null = null;
    const source = sourceOf(tx);
    const row = { ...tx, externalId: tx.externalId ?? null, endToEndId: tx.endToEndId ?? null };
    const key = isCamtFamily(source)
      ? secondaryKey({
          ...row,
          counterpartyIban: tx.counterpartyIban ?? null,
          detailIndex: detailOf(tx),
        })
      : null;
    if (key) {
      const ex = bySecondary.get(key);
      if (ex && (ex.importId === null || ex.importId !== (params.importId ?? null))) {
        return { skip: true, fingerprint, hold };
      }
    }
    if (tx.raw?.interim === true) hold = 'INTERIM';
    if (source === 'camt054') {
      const { ref, e2e } = stableIds(row);
      const hasId = !!(ref || e2e);
      const ex = byFingerprint.get(fingerprint);
      if (
        ex &&
        ex.source === 'camt054' &&
        ex.importId &&
        params.importId &&
        ex.importId !== params.importId
      ) {
        const exIds = stableIds(ex);
        const differ =
          (ref && exIds.ref ? ref !== exIds.ref : false) ||
          (!(ref && exIds.ref) && e2e && exIds.e2e ? e2e !== exIds.e2e : false);
        if (differ) {
          // Two genuinely different payments that look identical: give the second its own
          // fingerprint (derived from the references) so it is not dropped.
          fingerprint = sha(`v1x|${fingerprint}|${ref ?? ''}|${e2e ?? ''}`);
        } else {
          fingerprint = sha(`v1d|${fingerprint}|${params.importId}`);
          hold = 'POSSIBLE_DUPLICATE';
        }
      }
      if (!hold && tx.raw?.noBookingDate === true && !hasId) hold = 'NO_BOOKING_DATE';
    }
    return { skip: false, fingerprint, hold };
  });

  const insertedIds: string[] = [];
  const linkRows: LinkRow[] = [];
  const held: Partial<Record<HoldReason, number>> = {};
  let inserted = 0;
  let skipped = 0;
  const kept = txs.map((tx, i) => ({ tx, plan: plans[i]! })).filter((e) => !e.plan.skip);
  skipped = txs.length - kept.length;
  for (let i = 0; i < kept.length; i += INSERT_CHUNK) {
    const slice = kept.slice(i, i + INSERT_CHUNK);
    const chunk = slice.map(({ tx, plan }) => ({
      bankAccountId: params.bankAccountId,
      importId: params.importId ?? null,
      syncRunId: params.syncRunId ?? null,
      fingerprint: plan.fingerprint,
      externalId: tx.externalId?.slice(0, 200) ?? null,
      bookingDate: tx.bookingDate,
      valueDate: tx.valueDate ?? null,
      amount: tx.amount,
      currency: tx.currency,
      counterpartyName: tx.counterpartyName ?? null,
      counterpartyIban: tx.counterpartyIban ?? null,
      counterpartyBic: tx.counterpartyBic ?? null,
      remittanceInformation: tx.remittanceInformation ?? null,
      endToEndId: tx.endToEndId ?? null,
      bankTransactionCode: tx.bankTransactionCode ?? null,
      rawData: {
        ...(tx.raw ?? {}),
        ...(tx.bookingText ? { bookingText: tx.bookingText } : {}),
        ...(plan.hold ? { hold: plan.hold } : {}),
        ...(params.trusted === false ? { untrustedSource: true } : {}),
      },
      matchStatus: tx.amount > 0 && !plan.hold ? ('UNMATCHED' as const) : ('IGNORED' as const),
    }));
    const rows = await ctx.db
      .insert(bankTransactions)
      .values(chunk)
      .onConflictDoNothing({
        target: [bankTransactions.bankAccountId, bankTransactions.fingerprint],
      })
      .returning({ id: bankTransactions.id, fingerprint: bankTransactions.fingerprint });
    inserted += rows.length;
    if (params.trusted !== false && rows.length < slice.length) {
      const insertedFps = new Set(rows.map((r) => r.fingerprint));
      const conflicting = slice.map((e) => e.plan.fingerprint).filter((fp) => !insertedFps.has(fp));
      insertedIds.push(
        ...(await promoteTrustedRows(ctx, params.bankAccountId, { fingerprints: conflicting })),
      );
    }
    const byFp = new Map(slice.map((e) => [e.plan.fingerprint, e]));
    for (const row of rows) {
      const entry = byFp.get(row.fingerprint)!;
      const { tx, plan } = entry;
      if (plan.hold) held[plan.hold] = (held[plan.hold] ?? 0) + 1;
      if (tx.amount > 0 && !plan.hold) insertedIds.push(row.id);
      linkRows.push({
        id: row.id,
        amount: tx.amount,
        currency: tx.currency,
        bookingDate: tx.bookingDate,
        counterpartyIban: tx.counterpartyIban ?? null,
        remittanceInformation: tx.remittanceInformation ?? null,
        hold: plan.hold,
        interim: tx.raw?.interim === true,
        source: typeof tx.raw?.source === 'string' ? tx.raw.source : null,
        aggregate: tx.raw?.aggregate === true,
      });
    }
  }
  const linked = await linkHeldRows(
    ctx.db,
    params.bankAccountId,
    linkRows,
    params.interimWindowDays,
  );
  return {
    insertedIds,
    fetched: txs.length,
    duplicates: skipped + (kept.length - inserted),
    held,
    superseded: linked.superseded,
    aggregatesCovered: linked.aggregatesCovered,
  };
}

/** Human-readable import report lines for held / linked rows. */
export function heldWarnings(stored: StoredBatch): string[] {
  const out: string[] = [];
  const h = stored.held;
  if (h.INTERIM)
    out.push(
      `${h.INTERIM} interim (MT942) entries stored as "interim – not booked yet": they are never matched or paid automatically; the final statement supersedes them`,
    );
  if (h.POSSIBLE_DUPLICATE)
    out.push(
      `${h.POSSIBLE_DUPLICATE} camt.054 entries look identical to entries of an earlier camt.054 file without a reference: stored as "possible duplicate – review" and not matched`,
    );
  if (h.NO_BOOKING_DATE)
    out.push(
      `${h.NO_BOOKING_DATE} camt.054 entries without booking date and reference: stored as "needs review" and not matched`,
    );
  if (stored.superseded > 0)
    out.push(`${stored.superseded} interim entries were superseded by final bookings`);
  if (stored.aggregatesCovered > 0)
    out.push(
      `${stored.aggregatesCovered} batch entries are covered by per-transaction camt.054 entries and were not counted twice`,
    );
  return out;
}

export type StatementImportStatus = 'COMPLETED' | 'FAILED' | 'DUPLICATE_FILE' | 'UNSUPPORTED';

export interface StatementImportResult {
  fileName: string;
  status: StatementImportStatus;
  importId: string | null;
  format: BankStatementFormat | null;
  transactionCount: number;
  importedCount: number;
  duplicateCount: number;
  /** New credit transactions to run the matcher on. */
  insertedIds: string[];
  errorCode: string | null;
  errorMessage: string | null;
  warnings: string[];
}

export interface ImportStatementParams {
  account: Pick<BankAccountRow, 'id' | 'iban' | 'currency'>;
  connectionId?: string | null;
  source: BankImportSource;
  fileName: string;
  bytes: Uint8Array;
  uploadedByUserId?: string | null;
  formatHint?: StatementFormatHint;
  csvProfile?: CsvProfile;
  /** false = mail origin not proven (DKIM/SPF): transactions go to the review queue only. Default true. */
  trusted?: boolean;
}

const EXTENSION: Record<BankStatementFormat, string> = {
  CAMT052: 'xml',
  CAMT053: 'xml',
  MT940: 'sta',
  CSV: 'csv',
};

const CONTENT_TYPE: Record<BankStatementFormat, string> = {
  CAMT052: 'application/xml',
  CAMT053: 'application/xml',
  MT940: 'text/plain',
  CSV: 'text/csv',
};

/**
 * Imports a statement file (or every statement inside a ZIP archive): SHA-256 file dedupe,
 * original stored in object storage (`bank-statements/<account>/<yyyy>/<sha256>.<ext>`),
 * parse, account check, fingerprint dedupe per transaction. Matching is left to the caller.
 */
export async function importStatementFile(
  ctx: CoreContext,
  params: ImportStatementParams,
): Promise<StatementImportResult[]> {
  let sources: StatementSource[];
  try {
    sources = expandStatementFiles({ fileName: params.fileName, bytes: params.bytes });
  } catch (err) {
    return [failure(params.fileName, null, err)];
  }
  if (sources.length === 0) {
    return [
      failure(
        params.fileName,
        null,
        new StatementParseError('UNSUPPORTED_FORMAT', 'The archive contains no statement files'),
      ),
    ];
  }
  const results: StatementImportResult[] = [];
  for (const source of sources) results.push(await importOne(ctx, params, source));
  return results;
}

function failure(
  fileName: string,
  format: BankStatementFormat | null,
  err: unknown,
  importId: string | null = null,
): StatementImportResult {
  const code = err instanceof StatementParseError ? err.code : 'IMPORT_FAILED';
  return {
    fileName,
    status: code === 'UNSUPPORTED_FORMAT' && !importId ? 'UNSUPPORTED' : 'FAILED',
    importId,
    format,
    transactionCount: 0,
    importedCount: 0,
    duplicateCount: 0,
    insertedIds: [],
    errorCode: code,
    errorMessage: err instanceof Error ? err.message : String(err),
    warnings: [],
  };
}

async function importOne(
  ctx: CoreContext,
  params: ImportStatementParams,
  source: StatementSource,
): Promise<StatementImportResult> {
  const fileName = source.fileName.slice(0, 255);
  if (source.bytes.length > MAX_STATEMENT_FILE_BYTES) {
    return failure(fileName, null, new StatementParseError('UNSUPPORTED_FORMAT', 'File too large'));
  }
  const csvProfile = params.csvProfile ?? csvProfileSchema.parse({});
  let format: BankStatementFormat | null;
  try {
    format =
      params.formatHint && params.formatHint !== 'AUTO'
        ? params.formatHint
        : detectStatementFormat(decodeText(source.bytes, 'auto'), fileName);
  } catch (err) {
    return failure(fileName, null, err);
  }
  if (!format) {
    return failure(
      fileName,
      null,
      new StatementParseError('UNSUPPORTED_FORMAT', 'Unknown file format'),
    );
  }

  const sha256 = createHash('sha256').update(source.bytes).digest('hex');
  const [existing] = await ctx.db
    .select({ id: bankStatementImports.id, status: bankStatementImports.status })
    .from(bankStatementImports)
    .where(
      and(
        eq(bankStatementImports.bankAccountId, params.account.id),
        eq(bankStatementImports.sha256, sha256),
      ),
    );
  if (existing && existing.status !== 'FAILED') {
    // The identical file may have arrived first through a forged (untrusted) mail.
    const promoted =
      params.trusted !== false
        ? await promoteTrustedRows(ctx, params.account.id, { importId: existing.id })
        : [];
    return {
      ...failure(fileName, format, null, existing.id),
      insertedIds: promoted,
      status: 'DUPLICATE_FILE',
      errorCode: null,
      errorMessage: null,
    };
  }
  // A previously failed file may be imported again (e.g. after fixing the CSV mapping).
  if (existing)
    await ctx.db.delete(bankStatementImports).where(eq(bankStatementImports.id, existing.id));

  const storage = requireCapability(ctx, 'storage');
  const year = new Date().getUTCFullYear();
  const objectKey = `bank-statements/${params.account.id}/${year}/${sha256}.${EXTENSION[format]}`;
  await storage.put('documents', objectKey, source.bytes, CONTENT_TYPE[format]);

  let importId: string;
  try {
    const [row] = await ctx.db
      .insert(bankStatementImports)
      .values({
        bankAccountId: params.account.id,
        connectionId: params.connectionId ?? null,
        source: params.source,
        format,
        fileName,
        objectKey,
        sha256,
        sizeBytes: source.bytes.length,
        status: 'PROCESSING',
        uploadedByUserId: params.uploadedByUserId ?? null,
      })
      .returning({ id: bankStatementImports.id });
    importId = row!.id;
  } catch (err) {
    // Concurrent upload of the same file.
    const [dup] = await ctx.db
      .select({ id: bankStatementImports.id })
      .from(bankStatementImports)
      .where(
        and(
          eq(bankStatementImports.bankAccountId, params.account.id),
          eq(bankStatementImports.sha256, sha256),
        ),
      );
    if (dup) {
      return {
        ...failure(fileName, format, null, dup.id),
        status: 'DUPLICATE_FILE',
        errorCode: null,
        errorMessage: null,
      };
    }
    throw err;
  }

  try {
    const parsed = parseStatementFile(source, {
      formatHint: format,
      csvProfile,
      defaultCurrency: params.account.currency,
    });
    const foreign = parsed.statements.find(
      (s) =>
        s.accountIdentifier &&
        !accountIdentifierMatchesIban(s.accountIdentifier, params.account.iban),
    );
    if (foreign) {
      throw new StatementParseError(
        'UNSUPPORTED_FORMAT',
        `The file belongs to another account (${foreign.accountIdentifier})`,
      );
    }
    const transactions = parsed.statements.flatMap((s) => s.transactions);
    const from = parsed.statements
      .map((s) => s.periodFrom)
      .filter((d): d is string => !!d)
      .sort()[0];
    const to = parsed.statements
      .map((s) => s.periodTo)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
    const statementIds =
      parsed.statements
        .map((s) => s.statementId)
        .filter(Boolean)
        .join(', ')
        .slice(0, 500) || null;

    // The same camt.054 message re-sent with different bytes (new creation timestamp …) is a
    // re-import: same notification id + entry count + period → nothing is stored again.
    if (
      statementIds &&
      transactions.length > 0 &&
      transactions.every((t) => t.raw?.source === 'camt054')
    ) {
      const [sameMessage] = await ctx.db
        .select({ id: bankStatementImports.id })
        .from(bankStatementImports)
        .where(
          and(
            eq(bankStatementImports.bankAccountId, params.account.id),
            eq(bankStatementImports.statementId, statementIds),
            eq(bankStatementImports.status, 'COMPLETED'),
            eq(bankStatementImports.transactionCount, transactions.length),
            from ? eq(bankStatementImports.periodFrom, from) : undefined,
            to ? eq(bankStatementImports.periodTo, to) : undefined,
            ne(bankStatementImports.id, importId),
          ),
        )
        .limit(1);
      if (sameMessage) {
        await ctx.db.delete(bankStatementImports).where(eq(bankStatementImports.id, importId));
        return {
          ...failure(fileName, format, null, sameMessage.id),
          status: 'DUPLICATE_FILE',
          errorCode: null,
          errorMessage: null,
        };
      }
    }

    const stored = await storeTransactions(ctx, {
      bankAccountId: params.account.id,
      importId,
      transactions,
      trusted: params.trusted,
    });
    if (params.trusted === false) {
      parsed.warnings.push(
        'Mail sender not authenticated (no aligned DKIM/DMARC pass from the trusted mail server for an accepted domain): transactions are never booked automatically and wait in the review queue',
      );
    }
    parsed.warnings.push(...heldWarnings(stored));
    const imported = stored.fetched - stored.duplicates;
    await ctx.db
      .update(bankStatementImports)
      .set({
        status: 'COMPLETED',
        format: parsed.format,
        statementId: statementIds,
        periodFrom: from ?? null,
        periodTo: to ?? null,
        transactionCount: transactions.length,
        importedCount: imported,
        duplicateCount: stored.duplicates,
        errors: parsed.warnings.length > 0 ? { warnings: parsed.warnings.slice(0, 50) } : null,
        completedAt: new Date(),
      })
      .where(eq(bankStatementImports.id, importId));
    return {
      fileName,
      status: 'COMPLETED',
      importId,
      format: parsed.format,
      transactionCount: transactions.length,
      importedCount: imported,
      duplicateCount: stored.duplicates,
      insertedIds: stored.insertedIds,
      errorCode: null,
      errorMessage: null,
      warnings: parsed.warnings,
    };
  } catch (err) {
    const result = failure(fileName, format, err, importId);
    await ctx.db
      .update(bankStatementImports)
      .set({
        status: 'FAILED',
        errors: { code: result.errorCode, message: result.errorMessage },
        completedAt: new Date(),
      })
      .where(eq(bankStatementImports.id, importId));
    return { ...result, status: 'FAILED' };
  }
}
