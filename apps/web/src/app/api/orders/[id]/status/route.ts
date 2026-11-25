import { DomainError } from '@tix/core';
import { invoices, tickets } from '@tix/db';
import { and, count, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getCore } from '@/server/core';
import { handle, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

/**
 * GET – light status of an order's generated documents (guest link token or customer account):
 * counts of valid tickets and invoices. The order page polls it while the worker prepares the
 * documents and reloads itself only when a count changed.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const orderId = uuidParam.parse((await params).id);
    if (!(await canAccessOrder(orderId, new URL(request.url).searchParams.get('t')))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    const db = getCore().db;
    const [[ticketRow], [invoiceRow]] = await Promise.all([
      db
        .select({ n: count() })
        .from(tickets)
        .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'VALID'))),
      db.select({ n: count() }).from(invoices).where(eq(invoices.orderId, orderId)),
    ]);
    return NextResponse.json(
      { validTickets: ticketRow?.n ?? 0, invoices: invoiceRow?.n ?? 0 },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
