import { DomainError, orderUrl, startAdjustmentPayPalPayment } from '@tix/core';
import { orderAdjustments, orders } from '@tix/db';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { enforceRateLimit, handle, parseBody, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ t: z.string().max(2_000).optional(), adjustmentId: z.uuid() });

/** POST – starts the PayPal payment of a confirmed additional payment; returns the approval URL. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = uuidParam.parse((await params).id);
    const { t, adjustmentId } = await parseBody(request, bodySchema);
    if (!(await canAccessOrder(id, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    await enforceRateLimit('adjustment-paypal-start', id, 10, 60_000);
    const core = getCore();
    // The adjustment must belong to the order the caller may access.
    const [adjustment] = await core.db
      .select({ orderId: orderAdjustments.orderId })
      .from(orderAdjustments)
      .where(eq(orderAdjustments.id, adjustmentId));
    if (!adjustment || adjustment.orderId !== id) {
      throw new DomainError('ADJUSTMENT_NOT_FOUND', 'Additional payment not found', 404);
    }
    const started = await startAdjustmentPayPalPayment(core, adjustmentId);
    if (started.status === 'REDIRECT') return NextResponse.json({ redirect: started.url });
    const [order] = await core.db
      .select({ id: orders.id, orderNumber: orders.orderNumber, locale: orders.locale })
      .from(orders)
      .where(eq(orders.id, id));
    return NextResponse.json({ redirect: orderUrl(core, order!) });
  });
}
