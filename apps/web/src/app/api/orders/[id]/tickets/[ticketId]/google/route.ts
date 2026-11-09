import { DomainError, ensureGoogleSaveUrl, listOrderTickets } from '@tix/core';
import { getCore } from '@/server/core';
import { handle, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';
import { withWalletErrors, withWalletRedirect } from '@/server/wallet-errors';

export const dynamic = 'force-dynamic';

/** GET – creates / updates the Google Wallet object of a VALID ticket and redirects to "Save". */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; ticketId: string }> },
) {
  return handle(async () => {
    const { id, ticketId } = await params;
    const orderId = uuidParam.parse(id);
    const ticket = uuidParam.parse(ticketId);
    const t = new URL(request.url).searchParams.get('t');
    return withWalletRedirect(request, orderId, async () => {
      if (!(await canAccessOrder(orderId, t))) {
        throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
      }
      const core = getCore();
      const owned = (await listOrderTickets(core, orderId)).some((row) => row.id === ticket);
      if (!owned) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
      const url = await withWalletErrors('google', () => ensureGoogleSaveUrl(core, ticket));
      return new Response(null, {
        status: 302,
        headers: { location: url, 'cache-control': 'private, no-store' },
      });
    });
  });
}
