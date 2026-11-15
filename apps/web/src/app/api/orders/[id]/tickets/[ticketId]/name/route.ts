import { DomainError, changeAttendeeName, changeAttendeeNameInput } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit, handle, parseBody, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

const bodySchema = changeAttendeeNameInput.extend({ t: z.string().max(2_000).optional() });

/** POST – the buyer changes the attendee name of one of their tickets (self-service). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; ticketId: string }> },
) {
  return handle(async () => {
    const { id, ticketId } = await params;
    const orderId = uuidParam.parse(id);
    const { t, name } = await parseBody(request, bodySchema);
    if (!(await canAccessOrder(orderId, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    await enforceRateLimit('ticket-self-service', orderId, 30, 3_600_000);
    await enforceRateLimit('ticket-self-service-ip', await clientIp(), 120, 3_600_000);
    const result = await changeAttendeeName(getCore(), {
      orderId,
      ticketId: uuidParam.parse(ticketId),
      name,
      actor: { type: 'CUSTOMER' },
    });
    return NextResponse.json({ attendeeName: result.attendeeName });
  });
}
