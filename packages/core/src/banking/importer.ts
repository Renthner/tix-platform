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
import { and, eq } from 'drizzle-orm';
import { requireCapability, type CoreContext } from '../context';
import type { BankAccountRow } from './connections';
import { fingerprintBatch } from './fingerprint';
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

export interface StoredBatch {
  /** Ids of newly inserted transactions (credits only are relevant for matching). */
  insertedIds: string[];
  fetched: number;
  duplicates: number;
}

/**
 * Inserts parsed transactions; rows whose fingerprint already exists for the account are
 * skipped (ON CONFLICT DO NOTHING). Debits are stored as IGNORED – only credits are
 * reconciled.
 */
export async function storeTransactions(
  ctx: Pick<CoreContext, 'db'>,
  params: {
    bankAccountId: string;
    importId?: string | null;
    syncRunId?: string | null;
    transactions: readonly ParsedTransaction[];
  },
): Promise<StoredBatch> {
  const fingerprints = fingerprintBatch(params.transactions);
  const insertedIds: string[] = [];
  let inserted = 0;
  for (let i = 0; i < params.transactions.length; i += INSERT_CHUNK) {
    const chunk = params.transactions.slice(i, i + INSERT_CHUNK).map((tx, j) => ({
      bankAccountId: params.bankAccountId,
      importId: params.importId ?? null,
      syncRunId: params.syncRunId ?? null,
      fingerprint: fingerprints[i + j]!,
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
      rawData: { ...(tx.raw ?? {}), ...(tx.bookingText ? { bookingText: tx.bookingText } : {}) },
      matchStatus: tx.amount > 0 ? ('UNMATCHED' as const) : ('IGNORED' as const),
    }));
    const rows = await ctx.db
      .insert(bankTransactions)
      .values(chunk)
      .onConflictDoNothing({
        target: [bankTransactions.bankAccountId, bankTransactions.fingerprint],
      })
      .returning({ id: bankTransactions.id, amount: bankTransactions.amount });
    inserted += rows.length;
    for (const row of rows) if (row.amount > 0) insertedIds.push(row.id);
  }
  return {
    insertedIds,
    fetched: params.transactions.length,
    duplicates: params.transactions.length - inserted,
  };
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
    return {
      ...failure(fileName, format, null, existing.id),
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
    const stored = await storeTransactions(ctx, {
      bankAccountId: params.account.id,
      importId,
      transactions,
    });
    const from = parsed.statements
      .map((s) => s.periodFrom)
      .filter((d): d is string => !!d)
      .sort()[0];
    const to = parsed.statements
      .map((s) => s.periodTo)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
    const imported = stored.fetched - stored.duplicates;
    await ctx.db
      .update(bankStatementImports)
      .set({
        status: 'COMPLETED',
        format: parsed.format,
        statementId:
          parsed.statements
            .map((s) => s.statementId)
            .filter(Boolean)
            .join(', ')
            .slice(0, 500) || null,
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
