import { DomainError, loadInvoicePdf } from '@tix/core';
import { getCore } from '@/server/core';
import { handle, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

/** GET – invoice / credit note PDF of an order (guest link token or customer account). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; invoiceId: string }> },
) {
  return handle(async () => {
    const { id, invoiceId } = await params;
    const orderId = uuidParam.parse(id);
    const t = new URL(request.url).searchParams.get('t');
    if (!(await canAccessOrder(orderId, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    const pdf = await loadInvoicePdf(getCore(), uuidParam.parse(invoiceId));
    if (pdf.orderId !== orderId) {
      throw new DomainError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
    }
    return new Response(Buffer.from(pdf.bytes), {
      headers: {
        'content-type': pdf.contentType,
        'content-disposition': `attachment; filename="${pdf.fileName.replace(/[^\w.-]/g, '_')}"`,
        'cache-control': 'private, no-store',
      },
    });
  });
}
