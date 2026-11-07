import { DomainError, placeOrder, startPayPalPayment } from '@tix/core';
import { checkoutInputSchema } from '@tix/shared';
import { NextResponse } from 'next/server';
import { getCore } from '@/server/core';
import { getCustomerSession } from '@/server/customer-session';
import { clientIp, enforceRateLimit, handle, parseBody } from '@/server/http';
import { readSessionId } from '@/server/session';

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
    const customer = await getCustomerSession();
    const core = getCore();
    const placed = await placeOrder(core, {
      sessionId: sid,
      input,
      account: customer ? { customerId: customer.customerId, email: customer.email } : null,
      ipAddress: await clientIp(),
    });
    const orderPath = `/${placed.locale}/orders/${encodeURIComponent(placed.orderNumber)}?t=${encodeURIComponent(placed.accessToken)}`;
    let redirect = orderPath;
    if (placed.status === 'PENDING' && placed.method === 'PAYPAL') {
      try {
        const started = await startPayPalPayment(core, placed.orderId);
        if (started.status === 'REDIRECT') redirect = started.url;
      } catch (err) {
        // The order exists and keeps its seats; the customer can retry on the order page.
        console.error('[checkout] PayPal payment could not be started', err);
        redirect = `${orderPath}&paypal=unavailable`;
      }
    }
    return NextResponse.json(
      { orderNumber: placed.orderNumber, status: placed.status, redirect },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
