import 'server-only';
import { orders } from '@tix/db';
import { verifyOrderAccessToken } from '@tix/core';
import { eq } from 'drizzle-orm';
import { getCore } from './core';
import { getCustomerSession } from './customer-session';

/**
 * Access to an order page / document: either the signed guest link (`?t=` from the order
 * e-mails) or a signed-in customer account with verified e-mail that owns the order.
 */
export async function canAccessOrder(orderId: string, token: string | null | undefined) {
  const core = getCore();
  if (token && verifyOrderAccessToken(core, token) === orderId) return true;
  const customer = await getCustomerSession();
  if (!customer?.emailVerified) return false;
  const [row] = await core.db
    .select({ customerId: orders.customerId })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.customerId === customer.customerId;
}
