import { renderSingleTicketPdf } from '@tix/core';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';
import { pdfResponse } from '@/server/pdf-response';

export const dynamic = 'force-dynamic';

/** GET – a single ticket as PDF (admin). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; ticketId: string }> },
) {
  return handle(async () => {
    const session = await adminForApi(['FINANCE', 'EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const { id, ticketId } = await params;
    return pdfResponse(
      await renderSingleTicketPdf(getCore(), uuidParam.parse(ticketId), uuidParam.parse(id)),
    );
  });
}
