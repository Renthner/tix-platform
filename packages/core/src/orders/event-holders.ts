import { orderItems, orders, tickets, type Executor } from '@tix/db';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { HolderTicketRef } from '../tickets/holder-mail';

/**
 * Holders of passed-on (transferred) tickets as recipients of event notices (cancellation,
 * postponement, event mailings). A holder is only mailed when the address is usable and differs
 * from the buyer's order address (case-insensitive, trimmed) – the buyer gets the buyer version.
 * Holder mails never carry order data or the order link (see `tickets/holder-mail.ts`).
 */

/** Same rule as the outbox (`createEmailMessage` refuses anything else with INVALID_RECIPIENT). */
const emailAddress = z.email();

export const emailKeyOf = (email: string | null | undefined) => (email ?? '').trim().toLowerCase();

/** The trimmed holder address when it is deliverable and not the buyer's own address, else null. */
export function holderNoticeAddress(
  holderEmail: string | null | undefined,
  orderEmail: string | null | undefined,
): string | null {
  const email = holderEmail?.trim();
  if (!email || email.toLowerCase() === emailKeyOf(orderEmail)) return null;
  return emailAddress.safeParse(email).success ? email : null;
}

export interface HolderNoticeGroup {
  email: string;
  tickets: HolderTicketRef[];
}

/**
 * Groups the holder tickets of ONE order (e.g. the tickets voided by a cancellation) by holder
 * address. Tickets whose holder is the buyer and unusable addresses are left out; `skipped` counts
 * the tickets with a stored but unusable holder address.
 */
export function groupHolderNotices(
  holders: readonly HolderTicketRef[],
  orderEmail: string | null | undefined,
): { groups: HolderNoticeGroup[]; skipped: number } {
  const byKey = new Map<string, HolderNoticeGroup>();
  let skipped = 0;
  for (const ticket of holders) {
    const email = holderNoticeAddress(ticket.holderEmail, orderEmail);
    if (!email) {
      const own = emailKeyOf(ticket.holderEmail) === emailKeyOf(orderEmail);
      if (ticket.holderEmail?.trim() && !own) skipped += 1;
      continue;
    }
    const key = email.toLowerCase();
    const group = byKey.get(key) ?? { email, tickets: [] };
    group.tickets.push(ticket);
    byKey.set(key, group);
  }
  return { groups: [...byKey.values()], skipped };
}

export interface EventHolderRecipient {
  email: string;
  /** Newest matching ticket of the holder (its ticket page is linked in the mail). */
  ticketId: string;
  /** Source order (kept in the mail envelope only, never linked). */
  orderId: string;
  locale: string;
  holderName: string | null;
}

/**
 * Distinct current holders (one per address, newest ticket) of VALID passed-on tickets of an event
 * whose order matches the audience: `paidOnly` = paid orders with CONFIRMED items, otherwise also
 * unpaid orders with PENDING items; `categoryId` limits to the ticket's price category; `orderId`
 * to one order. Test orders, voided tickets, the buyer's own address and unusable addresses are
 * excluded.
 */
export async function loadEventHolderRecipients(
  db: Executor,
  input: {
    eventId: string;
    paidOnly: boolean;
    categoryId?: string | null;
    orderId?: string | null;
  },
): Promise<EventHolderRecipient[]> {
  const orderStatuses = input.paidOnly
    ? (['PAID', 'PARTIALLY_REFUNDED'] as const)
    : (['PENDING', 'AWAITING_PAYMENT', 'PAID', 'PARTIALLY_REFUNDED'] as const);
  const rows = await db
    .select({
      ticketId: tickets.id,
      holderEmail: tickets.holderEmail,
      holderName: tickets.attendeeName,
      orderId: orders.id,
      orderEmail: orders.email,
      locale: orders.locale,
    })
    .from(tickets)
    .innerJoin(
      orderItems,
      and(
        eq(orderItems.id, tickets.orderItemId),
        input.paidOnly
          ? eq(orderItems.status, 'CONFIRMED')
          : inArray(orderItems.status, ['PENDING', 'CONFIRMED']),
        input.categoryId ? eq(orderItems.priceCategoryId, input.categoryId) : undefined,
      ),
    )
    .innerJoin(orders, eq(orders.id, tickets.orderId))
    .where(
      and(
        eq(tickets.eventId, input.eventId),
        eq(tickets.status, 'VALID'),
        isNotNull(tickets.holderEmail),
        eq(orders.isTest, false),
        inArray(orders.status, [...orderStatuses]),
        input.orderId ? eq(tickets.orderId, input.orderId) : undefined,
      ),
    )
    .orderBy(desc(tickets.issuedAt), desc(tickets.id));
  const seen = new Set<string>();
  const result: EventHolderRecipient[] = [];
  for (const row of rows) {
    const email = holderNoticeAddress(row.holderEmail, row.orderEmail);
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      email,
      ticketId: row.ticketId,
      orderId: row.orderId,
      locale: row.locale,
      holderName: row.holderName,
    });
  }
  return result;
}
