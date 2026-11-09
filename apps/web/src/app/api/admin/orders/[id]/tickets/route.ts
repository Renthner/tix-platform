import { renderOrderTicketsPdf } from '@tix/core';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';
import { pdfResponse } from '@/server/pdf-response';

export const dynamic = 'force-dynamic';

/** GET – all valid tickets of an order as one PDF (admin). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(['FINANCE', 'EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    return pdfResponse(
      await renderOrderTicketsPdf(getCore(), uuidParam.parse((await params).id), { store: false }),
    );
  });
}
