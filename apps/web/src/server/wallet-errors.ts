import { DomainError } from '@tix/core';
import { orders } from '@tix/db';
import { eq } from 'drizzle-orm';
import { getCore } from '@/server/core';
import { getEnv } from '@/server/env';

/**
 * Runs a wallet pass generator; any failure that is not already a DomainError (Google / Apple
 * API errors, signing problems) is logged and surfaced as WALLET_UNAVAILABLE instead of a
 * generic INTERNAL_ERROR.
 */
export async function withWalletErrors<T>(provider: 'google' | 'apple', fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError) throw err;
    console.error(`[wallet] ${provider} pass failed`, err);
    throw new DomainError('WALLET_UNAVAILABLE', 'Wallet is currently unavailable', 503);
  }
}

/**
 * Wallet buttons are plain links, so a failure must never show JSON: redirects (303) to the
 * order page with `wallet=unavailable`. Unknown / unauthorised order or ticket stay 404.
 */
export async function withWalletRedirect(
  request: Request,
  orderId: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError && ['ORDER_NOT_FOUND', 'TICKET_NOT_FOUND'].includes(err.code)) {
      throw err;
    }
    console.error('[wallet] request failed, redirecting to order page', err);
    const [order] = await getCore()
      .db.select({ orderNumber: orders.orderNumber, locale: orders.locale })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    const t = new URL(request.url).searchParams.get('t');
    const base = getEnv().APP_URL.replace(/\/+$/, '');
    const query = `${t ? `t=${encodeURIComponent(t)}&` : ''}wallet=unavailable`;
    return new Response(null, {
      status: 303,
      headers: {
        location: `${base}/${order.locale}/orders/${encodeURIComponent(order.orderNumber)}?${query}`,
        'cache-control': 'private, no-store',
      },
    });
  }
}
