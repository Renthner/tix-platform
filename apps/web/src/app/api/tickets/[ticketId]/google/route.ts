import { ensureGoogleSaveUrl } from '@tix/core';
import { getCore } from '@/server/core';
import { handle } from '@/server/http';
import { requireHolderTicket } from '@/server/holder-ticket';
import { withWalletErrors } from '@/server/wallet-errors';

export const dynamic = 'force-dynamic';

/** GET – Google Wallet "Save" redirect of a transferred ticket (ticket link token of the recipient). */
export async function GET(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  return handle(async () => {
    const ticket = await requireHolderTicket(request, (await params).ticketId);
    const core = getCore();
    const url = await withWalletErrors('google', () => ensureGoogleSaveUrl(core, ticket.id));
    return new Response(null, {
      status: 302,
      headers: { location: url, 'cache-control': 'private, no-store' },
    });
  });
}
