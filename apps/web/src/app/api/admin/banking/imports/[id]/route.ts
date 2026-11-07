import { requireCapability } from '@tix/core';
import { bankStatementImports } from '@tix/db';
import { eq } from 'drizzle-orm';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<string, string> = {
  CAMT052: 'application/xml',
  CAMT053: 'application/xml',
  MT940: 'text/plain',
  CSV: 'text/csv',
};

/** GET – original statement file of an import (stored privately, streamed after the role check). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    if (!(await adminForApi(['FINANCE']))) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await params).id);
    const core = getCore();
    const [row] = await core.db
      .select({
        objectKey: bankStatementImports.objectKey,
        fileName: bankStatementImports.fileName,
        format: bankStatementImports.format,
      })
      .from(bankStatementImports)
      .where(eq(bankStatementImports.id, id));
    if (!row) return apiError('NOT_FOUND', 'Import not found', 404);
    const object = await requireCapability(core, 'storage').get('documents', row.objectKey);
    const name = row.fileName.split('/').pop() || 'statement';
    return new Response(Buffer.from(object.body), {
      headers: {
        'content-type': CONTENT_TYPES[row.format] ?? 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
