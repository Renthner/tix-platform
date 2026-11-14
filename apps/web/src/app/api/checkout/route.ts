import { requestLogger } from '@/server/logger';
import {
  DomainError,
  PayPalCredentialsError,
  getSetting,
  placeOrder,
  startPayPalPayment,
} from '@tix/core';
import { checkoutInputSchema } from '@tix/shared';
import { NextResponse } from 'next/server';
import { getCore } from '@/server/core';
import { getCustomerSession } from '@/server/customer-session';
import { clientIp, enforceRateLimit, handle, parseBody } from '@/server/http';
import { readSessionId } from '@/server/session';
import { getShopActor } from '@/server/shop-actor';

export const dynamic = 'force-dynamic';

/**
 * POST – "Place order (binding)": turns the cart into an order. Bank transfer → order page
 * with payment instructions; PayPal → redirect to the PayPal approval page.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const sid = await readSessionId();
    if (!sid) throw new DomainError('CART_EMPTY', 'Your cart is empty', 409);
    await enforceRateLimit('checkout', sid, 10, 60_000);
    const input = await parseBody(request, checkoutInputSchema);
    // Safety net per IP address (configurable, off when empty / 0). Charged only for requests
    // that passed input validation, so malformed submissions do not use up the allowance.
    const { checkoutsPerIpPer10Min } = await getSetting(getCore(), 'checkout');
    if (checkoutsPerIpPer10Min) {
      await enforceRateLimit('checkout-ip', await clientIp(), checkoutsPerIpPer10Min, 600_000);
    }
    const customer = await getCustomerSession();
    const core = getCore();
    const placed = await placeOrder(core, {
      sessionId: sid,
      input,
      account: customer ? { customerId: customer.customerId, email: customer.email } : null,
      ipAddress: await clientIp(),
      actor: await getShopActor(),
    });
    const orderPath = `/${placed.locale}/orders/${encodeURIComponent(placed.orderNumber)}?t=${encodeURIComponent(placed.accessToken)}`;
    let redirect = orderPath;
    if (placed.status === 'PENDING' && placed.method === 'PAYPAL') {
      try {
        const started = await startPayPalPayment(core, placed.orderId);
        if (started.status === 'REDIRECT') redirect = started.url;
      } catch (err) {
        // The order exists and keeps its seats; the customer can retry on the order page.
        if (err instanceof PayPalCredentialsError) {
          // Configuration problem, already logged by core.
          redirect = `${orderPath}&paypal=notavailable`;
        } else {
          requestLogger(request).error({ err }, '[checkout] PayPal payment could not be started');
          redirect = `${orderPath}&paypal=unavailable`;
        }
      }
    }
    return NextResponse.json(
      { orderNumber: placed.orderNumber, status: placed.status, redirect },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
