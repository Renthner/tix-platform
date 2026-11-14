import { requestLogger } from '@/server/logger';
import {
  completePayPalPayment,
  PayPalCredentialsError,
  verifyOrderAccessToken,
  type CompletePayPalResult,
} from '@tix/core';
import { orders } from '@tix/db';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getCore } from '@/server/core';
import { getEnv } from '@/server/env';
import { readMaintenance } from '@/server/maintenance-gate';

export const dynamic = 'force-dynamic';

const OUTCOME: Record<CompletePayPalResult['status'], string> = {
  PAID: 'paid',
  PENDING: 'pending',
  RETRY: 'failed',
  NOT_APPROVED: 'cancelled',
  FAILED: 'failed',
  NOT_PAYABLE: 'expired',
};

/**
 * GET – PayPal sends the buyer back here after approval (`token` = PayPal order id,
 * `t` = our signed order token). Captures the payment and continues on the order page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order') ?? '';
  const t = url.searchParams.get('t') ?? '';
  const paypalOrderId = url.searchParams.get('token') ?? '';
  const base = getEnv().APP_URL.replace(/\/+$/, '');
  // Restore running: no capture, no database access. The maintenance page reloads when it is over.
  if ((await readMaintenance()).active) return NextResponse.redirect(`${base}/`, 303);
  const core = getCore();
  if (!paypalOrderId || verifyOrderAccessToken(core, t) !== orderId) {
    return NextResponse.redirect(`${base}/`, 303);
  }
  const [order] = await core.db
    .select({ orderNumber: orders.orderNumber, locale: orders.locale })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return NextResponse.redirect(`${base}/`, 303);
  const page = `${base}/${order.locale}/orders/${encodeURIComponent(order.orderNumber)}?t=${encodeURIComponent(t)}`;

  let outcome = 'failed';
  try {
    const result = await completePayPalPayment(core, orderId, paypalOrderId);
    // Funding failed: PayPal lets the buyer pick another funding source.
    if (result.status === 'RETRY' && result.url) return NextResponse.redirect(result.url, 303);
    outcome = OUTCOME[result.status];
  } catch (err) {
    if (err instanceof PayPalCredentialsError) {
      // Configuration problem, already logged by core; the order keeps its seats.
      return NextResponse.redirect(`${page}&paypal=notavailable`, 303);
    }
    requestLogger(request).error({ err, orderId }, '[paypal] capture after return failed');
  }
  return NextResponse.redirect(`${page}&paypal=${outcome}`, 303);
}
