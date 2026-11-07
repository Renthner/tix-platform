import {
  MAX_STATEMENT_FILE_BYTES,
  importStatementFile,
  matchBankTransactions,
  type StatementImportResult,
} from '@tix/core';
import { bankAccounts, bankConnections } from '@tix/db';
import { fileImportConfigSchema } from '@tix/shared';
import { and, asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

const MAX_FILES = 20;

export interface UploadResponse {
  results: (Pick<
    StatementImportResult,
    | 'fileName'
    | 'status'
    | 'importId'
    | 'format'
    | 'transactionCount'
    | 'importedCount'
    | 'duplicateCount'
    | 'errorCode'
    | 'errorMessage'
    | 'warnings'
  > & { matched: number; review: number })[];
}

/**
 * POST multipart/form-data `accountId` + `files[]` – imports camt.052/053, MT940, CSV (also
 * ZIP archives) for a receiving account and runs the matcher on the new credits. A route
 * handler instead of a server action: statement files exceed the server-action body limit.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['FINANCE']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    // Defence in depth on top of the SameSite=strict admin cookie.
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== request.headers.get('host')) {
      return apiError('FORBIDDEN', 'Cross-site request', 403);
    }
    const form = await request.formData().catch(() => null);
    if (!form) return apiError('INVALID_BODY', 'Multipart body expected', 400);
    const accountId = uuidParam.safeParse(form.get('accountId'));
    if (!accountId.success) return apiError('ACCOUNT_REQUIRED', 'Select an account', 422);
    const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return apiError('FILE_REQUIRED', 'No file uploaded', 422);
    if (files.length > MAX_FILES) return apiError('TOO_MANY_FILES', 'Too many files', 422);
    const tooLarge = files.find((f) => f.size > MAX_STATEMENT_FILE_BYTES);
    if (tooLarge) return apiError('FILE_TOO_LARGE', `${tooLarge.name} is too large`, 413);

    const core = getCore();
    const [account] = await core.db
      .select({
        id: bankAccounts.id,
        iban: bankAccounts.iban,
        currency: bankAccounts.currency,
        isActive: bankAccounts.isActive,
      })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, accountId.data));
    if (!account?.isActive) return apiError('ACCOUNT_NOT_FOUND', 'Account not found', 404);
    // The account's file-import connection carries the CSV column mapping / format hint.
    const [connection] = await core.db
      .select({ id: bankConnections.id, config: bankConnections.config })
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.bankAccountId, account.id),
          eq(bankConnections.adapter, 'FILE_IMPORT'),
          eq(bankConnections.isActive, true),
        ),
      )
      .orderBy(asc(bankConnections.createdAt))
      .limit(1);
    const config = fileImportConfigSchema.parse(connection?.config ?? { adapter: 'FILE_IMPORT' });

    const response: UploadResponse = { results: [] };
    for (const file of files) {
      const results = await importStatementFile(core, {
        account,
        connectionId: connection?.id ?? null,
        source: 'UPLOAD',
        fileName: file.name.replace(/[\\/]/g, '_').slice(0, 200) || 'statement',
        bytes: new Uint8Array(await file.arrayBuffer()),
        uploadedByUserId: session.userId,
        formatHint: config.formatHint,
        csvProfile: config.csvProfile,
      });
      for (const result of results) {
        const summary = await matchBankTransactions(core, result.insertedIds);
        response.results.push({
          fileName: result.fileName,
          status: result.status,
          importId: result.importId,
          format: result.format,
          transactionCount: result.transactionCount,
          importedCount: result.importedCount,
          duplicateCount: result.duplicateCount,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          warnings: result.warnings.slice(0, 20),
          matched: summary.matched,
          review: summary.review,
        });
      }
    }
    await audit(core.db, session, 'bank.import.upload', 'bank_account', account.id, {
      files: response.results.map((r) => ({
        file: r.fileName,
        status: r.status,
        imported: r.importedCount,
      })),
    });
    revalidatePath('/', 'layout');
    return NextResponse.json(response, { headers: { 'cache-control': 'no-store' } });
  });
}
