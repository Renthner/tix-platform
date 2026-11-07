import { DomainError, cancelPendingOrderByCustomer } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { handle, parseBody, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ t: z.string().max(2_000).optional() });

/** POST – the buyer abandons an unpaid PayPal order (seats go back on sale). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = uuidParam.parse((await params).id);
    const { t } = await parseBody(request, bodySchema);
    if (!(await canAccessOrder(id, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    const cancelled = await cancelPendingOrderByCustomer(getCore(), id);
    if (!cancelled) {
      throw new DomainError('ORDER_NOT_CANCELLABLE', 'This order can no longer be cancelled', 409);
    }
    return new NextResponse(null, { status: 204 });
  });
}
