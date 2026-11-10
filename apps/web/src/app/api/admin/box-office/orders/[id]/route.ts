import { findActiveInvoice, listOrderTickets } from '@tix/core';
import { NextResponse } from 'next/server';
import { BOX_OFFICE_ROLES, loadBoxOfficeOrder } from '@/server/admin/box-office';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – state of a box-office sale (tickets ready? invoice issued yet?) for the success screen. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(BOX_OFFICE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const order = await loadBoxOfficeOrder(session, uuidParam.parse((await params).id));
    const core = getCore();
    const [tickets, invoice] = await Promise.all([
      listOrderTickets(core, order.id),
      findActiveInvoice(core.db, order.id),
    ]);
    return NextResponse.json(
      {
        orderNumber: order.orderNumber,
        status: order.status,
        ticketCount: tickets.length,
        invoiceId: invoice?.id ?? null,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
