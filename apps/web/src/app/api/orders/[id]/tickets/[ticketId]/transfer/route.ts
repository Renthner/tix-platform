import { DomainError, transferTicket, transferTicketInput } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit, handle, parseBody, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

const bodySchema = transferTicketInput.extend({ t: z.string().max(2_000).optional() });

/** POST – the buyer hands one of their tickets over to someone else (self-service). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; ticketId: string }> },
) {
  return handle(async () => {
    const { id, ticketId } = await params;
    const orderId = uuidParam.parse(id);
    const { t, ...input } = await parseBody(request, bodySchema);
    if (!(await canAccessOrder(orderId, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    // Each transfer sends an e-mail to a third party: keep the rate low.
    await enforceRateLimit('ticket-transfer', orderId, 10, 3_600_000);
    await enforceRateLimit('ticket-transfer-ip', await clientIp(), 30, 3_600_000);
    const result = await transferTicket(getCore(), {
      orderId,
      ticketId: uuidParam.parse(ticketId),
      ...input,
      actor: { type: 'CUSTOMER' },
    });
    return NextResponse.json({ ticketId: result.newTicketId });
  });
}
