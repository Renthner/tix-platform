import { renderOrderTicketsPdf } from '@tix/core';
import { BOX_OFFICE_ROLES, loadBoxOfficeOrder } from '@/server/admin/box-office';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';
import { pdfResponse } from '@/server/pdf-response';

export const dynamic = 'force-dynamic';

/** GET – ticket PDF of a box-office sale for printing (opens inline in a new tab). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(BOX_OFFICE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const order = await loadBoxOfficeOrder(session, uuidParam.parse((await params).id));
    return pdfResponse(
      await renderOrderTicketsPdf(getCore(), order.id, { store: false }),
      'inline',
    );
  });
}
