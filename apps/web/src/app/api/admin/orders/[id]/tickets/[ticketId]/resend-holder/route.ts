import { resendHolderTicketMail } from '@tix/core';
import { NextResponse } from 'next/server';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, parseBody, uuidParam } from '@/server/http';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/** POST – admin sends the recipient's ticket e-mail of a transferred ticket again. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; ticketId: string }> },
) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER', 'FINANCE']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const { id, ticketId } = await params;
    await parseBody(request, z.object({}));
    const orderId = uuidParam.parse(id);
    const ticket = uuidParam.parse(ticketId);
    const core = getCore();
    await resendHolderTicketMail(core, { orderId, ticketId: ticket });
    await audit(core.db, session, 'ticket.holder_mail_resent', 'order', orderId, {
      ticketId: ticket,
    });
    return NextResponse.json({ ok: true });
  });
}
