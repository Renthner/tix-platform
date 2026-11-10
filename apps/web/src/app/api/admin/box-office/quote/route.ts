import {
  BOX_OFFICE_PAYMENT_METHODS,
  DomainError,
  boxOfficeLineSchema,
  quoteBoxOfficeOrder,
} from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { BOX_OFFICE_ROLES, boxOfficePermissions } from '@/server/admin/box-office';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const quoteSchema = z.object({
  lines: z.array(boxOfficeLineSchema).min(1).max(500),
  payment: z.enum(BOX_OFFICE_PAYMENT_METHODS),
  allowBlocked: z.boolean().default(false),
});

/** POST – prices of the current selection (tariffs, box-office fees, VAT) without reserving anything. */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(BOX_OFFICE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const body = await parseBody(request, quoteSchema);
    const allowed = boxOfficePermissions(session);
    if (
      (body.payment === 'COMPLIMENTARY' && !allowed.complimentary) ||
      (body.allowBlocked && !allowed.blockedSeats) ||
      (body.lines.some((l) => l.priceOverrideCents !== undefined) && !allowed.priceOverride)
    ) {
      throw new DomainError('FORBIDDEN', 'Not allowed', 403);
    }
    const quote = await quoteBoxOfficeOrder(getCore(), { ...body, channel: 'BOX_OFFICE' });
    return NextResponse.json(quote, { headers: { 'cache-control': 'no-store' } });
  });
}
