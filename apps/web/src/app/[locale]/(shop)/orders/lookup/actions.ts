'use server';

import { DomainError, customerEmailSchema, requestOrderAccessLink } from '@tix/core';
import { hashToken } from '@tix/shared/server';
import { emailSubject } from '@/server/admin-login';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';
import { logger } from '@/server/logger';
import { assertNotInMaintenance } from '@/server/maintenance-assert';

export type OrderLookupState =
  | { status: 'idle' }
  | { status: 'error'; error: 'VALIDATION' | 'RATE_LIMITED'; at: number }
  /** Always the same, whether or not the data matched. */
  | { status: 'sent'; at: number };

const MINUTE = 60_000;

/** Guest "find my order": neutral answer, personal link per e-mail only for matching data. */
export async function lookupOrderAction(
  _prev: OrderLookupState,
  fd: FormData,
): Promise<OrderLookupState> {
  await assertNotInMaintenance();
  const orderNumber = String(fd.get('orderNumber') ?? '')
    .trim()
    .slice(0, 64);
  const email = customerEmailSchema.safeParse(String(fd.get('email') ?? ''));
  if (!orderNumber || !email.success)
    return { status: 'error', error: 'VALIDATION', at: Date.now() };

  try {
    await enforceRateLimit('order-lookup-ip', await clientIp(), 10, 15 * MINUTE);
    await enforceRateLimit('order-lookup-email', emailSubject(email.data), 5, 60 * MINUTE);
    // Keyed on order number AND e-mail: a stranger guessing addresses for a known order number
    // only burns their own budget and can never lock the buyer out of their order.
    await enforceRateLimit(
      'order-lookup-order',
      hashToken(`${orderNumber.toUpperCase()}\n${email.data.trim().toLowerCase()}`).slice(0, 32),
      3,
      60 * MINUTE,
    );
  } catch (err) {
    if (err instanceof DomainError && err.code === 'RATE_LIMITED') {
      return { status: 'error', error: 'RATE_LIMITED', at: Date.now() };
    }
    throw err;
  }

  try {
    await requestOrderAccessLink(getCore(), { orderNumber, email: email.data });
  } catch (err) {
    // Never reveal a problem that only occurs for existing orders.
    logger.error({ err }, 'order lookup mail failed');
  }
  return { status: 'sent', at: Date.now() };
}
