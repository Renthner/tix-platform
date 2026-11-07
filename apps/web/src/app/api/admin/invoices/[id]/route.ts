import { loadInvoicePdf } from '@tix/core';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – invoice / credit note PDF for the admin (renders and archives it when missing). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(['FINANCE', 'EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const pdf = await loadInvoicePdf(getCore(), uuidParam.parse((await params).id));
    return new Response(Buffer.from(pdf.bytes), {
      headers: {
        'content-type': pdf.contentType,
        'content-disposition': `attachment; filename="${pdf.fileName.replace(/[^\w.-]/g, '_')}"`,
        'cache-control': 'private, no-store',
      },
    });
  });
}
