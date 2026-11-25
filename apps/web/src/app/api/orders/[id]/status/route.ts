import { DomainError, getOrderLiveStatus } from '@tix/core';
import { NextResponse } from 'next/server';
import { getCore } from '@/server/core';
import { handle, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

/**
 * GET – light live status of an order (guest link token or customer account): order status, paid
 * amount, open additional payment and the counts of valid tickets and invoices. The order page
 * polls it while the order awaits a payment (from any channel, incl. an admin recording it by
 * hand) or while the worker prepares the documents, and reloads itself only when something changed.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const orderId = uuidParam.parse((await params).id);
    if (!(await canAccessOrder(orderId, new URL(request.url).searchParams.get('t')))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    const status = await getOrderLiveStatus(getCore(), orderId);
    if (!status) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    return NextResponse.json(status, { headers: { 'cache-control': 'no-store' } });
  });
}
