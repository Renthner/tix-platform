import 'server-only';
import { DomainError, resolveHolderTicket, verifyHolderTicketToken } from '@tix/core';
import { getCore } from './core';
import { clientIp, enforceRateLimit, uuidParam } from './http';

/**
 * Authorises a request for a ticket that was handed over to someone else: the signed ticket token
 * (`?t=`, sent in the transfer e-mail) must belong to exactly this ticket chain. Order access
 * tokens and customer sessions never open these routes. A transferred / cancelled ticket resolves to
 * 404, so an old link stops working.
 */
export async function requireHolderTicket(request: Request, rawTicketId: string) {
  const ticketId = uuidParam.parse(rawTicketId);
  await enforceRateLimit('holder-ticket', await clientIp(), 120, 10 * 60_000);
  const token = new URL(request.url).searchParams.get('t');
  const core = getCore();
  if (verifyHolderTicketToken(core, token) !== ticketId) {
    throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  }
  const resolved = await resolveHolderTicket(core, ticketId);
  if (!resolved || resolved.state !== 'VALID') {
    throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  }
  return resolved.row;
}
