import { DomainError, ensureApplePass, listOrderTickets } from '@tix/core';
import { getCore } from '@/server/core';
import { handle, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';
import { withWalletErrors, withWalletRedirect } from '@/server/wallet-errors';

export const dynamic = 'force-dynamic';

/** GET – Apple Wallet pass of a VALID ticket (guest link token or customer account). */
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
      const pass = await withWalletErrors('apple', () => ensureApplePass(core, ticket));
      return new Response(Buffer.from(pass.bytes), {
        headers: {
          'content-type': 'application/vnd.apple.pkpass',
          'content-disposition': `attachment; filename="${pass.fileName.replace(/[^\w.-]/g, '_')}"`,
          'cache-control': 'private, no-store',
        },
      });
    });
  });
}
