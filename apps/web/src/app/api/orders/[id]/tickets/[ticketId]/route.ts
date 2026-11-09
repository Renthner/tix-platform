import { DomainError, renderSingleTicketPdf } from '@tix/core';
import { getCore } from '@/server/core';
import { handle, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';
import { pdfResponse } from '@/server/pdf-response';

export const dynamic = 'force-dynamic';

/** GET – a single ticket as PDF (guest link token or customer account of the order). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; ticketId: string }> },
) {
  return handle(async () => {
    const { id, ticketId } = await params;
    const orderId = uuidParam.parse(id);
    const t = new URL(request.url).searchParams.get('t');
    if (!(await canAccessOrder(orderId, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    return pdfResponse(await renderSingleTicketPdf(getCore(), uuidParam.parse(ticketId), orderId));
  });
}
