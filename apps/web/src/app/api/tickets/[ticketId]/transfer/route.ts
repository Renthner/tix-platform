import { DomainError, transferTicketAsHolder, transferTicketInput } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit, handle, parseBody, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = transferTicketInput.extend({ t: z.string().max(2_000).optional() });

/**
 * POST – the current holder of a handed-over ticket passes it on (ticket link token). Same policy
 * as for the buyer; the holder cannot rename the ticket, the buyer cannot touch it any more.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  return handle(async () => {
    const ticketId = uuidParam.parse((await params).ticketId);
    const { t, ...input } = await parseBody(request, bodySchema);
    if (!t) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
    // Each transfer sends an e-mail to a third party: keep the rate low.
    await enforceRateLimit('ticket-transfer-holder', ticketId, 10, 3_600_000);
    await enforceRateLimit('ticket-transfer-ip', await clientIp(), 30, 3_600_000);
    const result = await transferTicketAsHolder(getCore(), { token: t, ticketId, ...input });
    return NextResponse.json({ ticketId: result.newTicketId });
  });
}
