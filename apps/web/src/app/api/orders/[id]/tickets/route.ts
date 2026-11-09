import { DomainError, renderOrderTicketsPdf } from '@tix/core';
import { getCore } from '@/server/core';
import { handle, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';
import { pdfResponse } from '@/server/pdf-response';

export const dynamic = 'force-dynamic';

/** GET – all valid tickets of an order as one PDF (guest link token or customer account). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const orderId = uuidParam.parse((await params).id);
    const t = new URL(request.url).searchParams.get('t');
    if (!(await canAccessOrder(orderId, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    return pdfResponse(await renderOrderTicketsPdf(getCore(), orderId, { store: false }));
  });
}
