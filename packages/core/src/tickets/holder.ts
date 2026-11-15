import { signToken, verifyToken } from '@tix/shared/server';
import type { CoreContext } from '../context';

/**
 * Holder access (recipient of a transferred ticket). A holder link opens exactly one ticket (and
 * follows re-issues for the same holder), never the order.
 */

const HOLDER_TOKEN_TYPE = 'ticket';
const HOLDER_TOKEN_TTL_SECONDS = 3 * 365 * 24 * 3600;

/** Link token of a transferred ticket: opens only that ticket (never the order). */
export function holderTicketToken(
  ctx: Pick<CoreContext, 'sessionSecret'>,
  ticketId: string,
): string {
  return signToken(
    HOLDER_TOKEN_TYPE,
    { tid: ticketId },
    HOLDER_TOKEN_TTL_SECONDS,
    ctx.sessionSecret,
  );
}

/** Ticket id of a valid holder token, else null. Order access tokens do not verify here. */
export function verifyHolderTicketToken(
  ctx: Pick<CoreContext, 'sessionSecret'>,
  token: string | null | undefined,
): string | null {
  const claims = verifyToken<{ tid: string }>(token, HOLDER_TOKEN_TYPE, ctx.sessionSecret);
  return claims && typeof claims.tid === 'string' ? claims.tid : null;
}

/** Absolute links of a holder ticket (page, PDF, wallet). */
export function holderTicketUrls(
  ctx: Pick<CoreContext, 'sessionSecret' | 'appUrl'>,
  ticket: { id: string },
  locale: string,
): { page: string; pdf: string; pkpass: string; google: string } | null {
  if (!ctx.appUrl) return null;
  const t = encodeURIComponent(holderTicketToken(ctx, ticket.id));
  const base = ctx.appUrl;
  return {
    page: `${base}/${locale}/tickets/${ticket.id}?t=${t}`,
    pdf: `${base}/api/tickets/${ticket.id}/pdf?t=${t}`,
    pkpass: `${base}/api/tickets/${ticket.id}/pkpass?t=${t}`,
    google: `${base}/api/tickets/${ticket.id}/google?t=${t}`,
  };
}
