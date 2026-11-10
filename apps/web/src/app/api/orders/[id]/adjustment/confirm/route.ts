import { DomainError, confirmAdjustment } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { enforceRateLimit, handle, parseBody, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ t: z.string().max(2_000).optional(), adjustmentId: z.uuid() });

/** POST – the customer confirms an additional payment ("Zahlungspflichtig bestätigen"). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = uuidParam.parse((await params).id);
    const { t, adjustmentId } = await parseBody(request, bodySchema);
    if (!(await canAccessOrder(id, t))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    await enforceRateLimit('adjustment-confirm', id, 10, 60_000);
    const result = await confirmAdjustment(getCore(), { adjustmentId, orderId: id });
    return NextResponse.json(result);
  });
}
