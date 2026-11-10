import { DomainError, boxOfficeSellSchema, createBoxOfficeOrder } from '@tix/core';
import { NextResponse } from 'next/server';
import { audit } from '@/server/admin/audit';
import { BOX_OFFICE_ROLES, boxOfficePermissions } from '@/server/admin/box-office';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, clientIp, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/** POST – sells the selected seats / standing spots (cash, card or complimentary). */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(BOX_OFFICE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const body = await parseBody(request, boxOfficeSellSchema);
    const allowed = boxOfficePermissions(session);
    const overrides = body.lines.some((l) => l.priceOverrideCents !== undefined);
    if (
      (body.payment === 'COMPLIMENTARY' && !allowed.complimentary) ||
      (body.allowBlocked && !allowed.blockedSeats) ||
      (overrides && !allowed.priceOverride)
    ) {
      throw new DomainError('FORBIDDEN', 'Not allowed', 403);
    }
    const core = getCore();
    const result = await createBoxOfficeOrder(core, {
      userId: session.userId,
      channel: 'BOX_OFFICE',
      lines: body.lines,
      payment: body.payment,
      buyer: body.buyer,
      sendEmail: body.sendEmail,
      note: body.note,
      allowBlocked: body.allowBlocked,
      priceOverrideReason: body.priceOverrideReason,
      locale: body.locale,
      holdTabId: body.tabId,
      ipAddress: await clientIp(),
    });
    await audit(core.db, session, 'order.box_office_sale', 'order', result.orderId, {
      orderNumber: result.orderNumber,
      payment: body.payment,
      totalGross: result.totalGross,
      tickets: result.ticketCount,
      allowBlocked: body.allowBlocked,
      priceOverrideReason: overrides ? (body.priceOverrideReason ?? null) : null,
    });
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
