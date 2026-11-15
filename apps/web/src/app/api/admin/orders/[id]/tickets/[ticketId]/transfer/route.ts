import { transferTicket, transferTicketInput } from '@tix/core';
import { NextResponse } from 'next/server';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, parseBody, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** POST – admin transfers a ticket (no deadline / policy). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; ticketId: string }> },
) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER', 'FINANCE']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const { id, ticketId } = await params;
    const orderId = uuidParam.parse(id);
    const ticket = uuidParam.parse(ticketId);
    const input = await parseBody(request, transferTicketInput);
    const core = getCore();
    const actor = { type: 'ADMIN' as const, userId: session.userId };
    const result = await transferTicket(core, { orderId, ticketId: ticket, ...input, actor });
    await audit(core.db, session, 'ticket.transferred', 'order', orderId, {
      ticketId: ticket,
      newTicketId: result.newTicketId,
    });
    return NextResponse.json({ ticketId: result.newTicketId });
  });
}
