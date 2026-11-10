import { DomainError, findActiveInvoice, loadInvoicePdf } from '@tix/core';
import { BOX_OFFICE_ROLES, loadBoxOfficeOrder } from '@/server/admin/box-office';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – invoice PDF of a box-office sale (404 until the invoice was issued). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(BOX_OFFICE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const order = await loadBoxOfficeOrder(session, uuidParam.parse((await params).id));
    const core = getCore();
    const invoice = await findActiveInvoice(core.db, order.id);
    if (!invoice) throw new DomainError('INVOICE_NOT_FOUND', 'No invoice for this order', 404);
    const pdf = await loadInvoicePdf(core, invoice.id);
    return new Response(Buffer.from(pdf.bytes), {
      headers: {
        'content-type': pdf.contentType,
        'content-disposition': `inline; filename="${pdf.fileName.replace(/[^\w.-]/g, '_')}"`,
        'cache-control': 'private, no-store',
      },
    });
  });
}
