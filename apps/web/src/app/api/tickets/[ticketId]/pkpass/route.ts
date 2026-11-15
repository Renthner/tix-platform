import { ensureApplePass } from '@tix/core';
import { getCore } from '@/server/core';
import { handle } from '@/server/http';
import { requireHolderTicket } from '@/server/holder-ticket';
import { withWalletErrors } from '@/server/wallet-errors';

export const dynamic = 'force-dynamic';

/** GET – Apple Wallet pass of a transferred ticket (ticket link token of the recipient). */
export async function GET(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  return handle(async () => {
    const ticket = await requireHolderTicket(request, (await params).ticketId);
    const core = getCore();
    const pass = await withWalletErrors('apple', () => ensureApplePass(core, ticket.id));
    return new Response(Buffer.from(pass.bytes), {
      headers: {
        'content-type': 'application/vnd.apple.pkpass',
        'content-disposition': `attachment; filename="${pass.fileName.replace(/[^\w.-]/g, '_')}"`,
        'cache-control': 'private, no-store',
      },
    });
  });
}
