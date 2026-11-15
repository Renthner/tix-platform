import { renderSingleTicketPdf } from '@tix/core';
import { getCore } from '@/server/core';
import { handle } from '@/server/http';
import { requireHolderTicket } from '@/server/holder-ticket';
import { pdfResponse } from '@/server/pdf-response';

export const dynamic = 'force-dynamic';

/** GET – the ticket PDF of a transferred ticket (ticket link token of the recipient). */
export async function GET(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  return handle(async () => {
    const ticket = await requireHolderTicket(request, (await params).ticketId);
    return pdfResponse(await renderSingleTicketPdf(getCore(), ticket.id, ticket.orderId, 'holder'));
  });
}
