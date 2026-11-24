import 'server-only';
import { orders, tickets } from '@tix/db';
import { verifyOrderAccessToken } from '@tix/core';
import { count, eq } from 'drizzle-orm';
import { getCore } from './core';
import { getCustomerSession } from './customer-session';
import { clientIp, enforceRateLimit } from './http';

/**
 * Generous per order + IP limit for the public document downloads (PDF rendering, wallet pass
 * signing). Call it AFTER `canAccessOrder` (a failed access check must not consume the quota) –
 * it scales with the ticket count: one download per ticket (PDF + two wallet passes)
 * plus reloads, minimum 60 per 10 minutes.
 */
export async function enforceOrderDocumentLimit(orderId: string): Promise<void> {
  const [row] = await getCore()
    .db.select({ n: count() })
    .from(tickets)
    .where(eq(tickets.orderId, orderId));
  const limit = Math.max(60, 4 * (row?.n ?? 0));
  await enforceRateLimit('order-document', `${orderId}:${await clientIp()}`, limit, 10 * 60_000);
}

/**
 * Access to an order page / document: either the signed guest link (`?t=` from the order
 * e-mails) or a signed-in customer account with verified e-mail that owns the order.
 */
export async function canAccessOrder(orderId: string, token: string | null | undefined) {
  const core = getCore();
  if (token && (await verifyOrderAccessToken(core, token)) === orderId) return true;
  const customer = await getCustomerSession();
  if (!customer?.emailVerified) return false;
  const [row] = await core.db
    .select({ customerId: orders.customerId })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.customerId === customer.customerId;
}
