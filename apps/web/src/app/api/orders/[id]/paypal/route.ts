import { DomainError, orderUrl, startPayPalPayment } from '@tix/core';
import { orders } from '@tix/db';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { enforceRateLimit, handle, parseBody, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';
import { rethrowPayPalCredentials } from '@/server/paypal-errors';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ t: z.string().max(2_000).optional() });

/** POST – (re)starts the PayPal payment of a pending order; returns the approval URL. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = uuidParam.parse((await params).id);
    const { t } = await parseBody(request, bodySchema);
    if (!(await canAccessOrder(id, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    await enforceRateLimit('paypal-start', id, 10, 60_000);
    const core = getCore();
    const started = await startPayPalPayment(core, id).catch(rethrowPayPalCredentials);
    if (started.status === 'REDIRECT') return NextResponse.json({ redirect: started.url });
    const [order] = await core.db
      .select({ id: orders.id, orderNumber: orders.orderNumber, locale: orders.locale })
      .from(orders)
      .where(eq(orders.id, id));
    return NextResponse.json({ redirect: orderUrl(core, order!) });
  });
}
