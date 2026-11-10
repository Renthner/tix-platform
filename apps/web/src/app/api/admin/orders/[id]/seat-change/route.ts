import {
  DomainError,
  assertSellable,
  boxOfficeSessionId,
  changeOrderSeats,
  getAvailability,
  getEventCached,
  getSeatMapForChannel,
  seatChangeSchema,
} from '@tix/core';
import { orderItems, orders } from '@tix/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { adminForApi, hasRole } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, parseBody, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

const ROLES = ['EVENT_MANAGER', 'FINANCE'] as const;

/**
 * GET – everything the seat-change screen needs for one event of the order: the seating plan
 * with the tariffs of the order's sales channel, the live availability and the movable items.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const orderId = uuidParam.parse((await params).id);
    const eventId = uuidParam.parse(new URL(request.url).searchParams.get('eventId'));
    const core = getCore();
    const [order] = await core.db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    const event = await getEventCached(core, eventId);
    assertSellable(event);
    const [map, availability, items] = await Promise.all([
      getSeatMapForChannel(core, event, order.channel),
      getAvailability(core, null, event),
      core.db
        .select({
          id: orderItems.id,
          seatId: orderItems.seatId,
          sectionLabel: orderItems.sectionLabel,
          rowLabel: orderItems.rowLabel,
          seatLabel: orderItems.seatLabel,
          categoryName: orderItems.categoryName,
          ticketTypeName: orderItems.ticketTypeName,
          ticketTypeId: orderItems.ticketTypeId,
          priceCategoryId: orderItems.priceCategoryId,
          priceGross: orderItems.priceGross,
          status: orderItems.status,
        })
        .from(orderItems)
        .where(
          and(
            eq(orderItems.orderId, orderId),
            eq(orderItems.eventId, eventId),
            eq(orderItems.kind, 'SEAT'),
            inArray(orderItems.status, ['PENDING', 'CONFIRMED']),
          ),
        )
        .orderBy(asc(orderItems.createdAt), asc(orderItems.id)),
    ]);
    return NextResponse.json(
      {
        map,
        availability,
        items,
        version: order.version,
        status: order.status,
        currency: order.currency,
        complimentary: order.paymentMethod === 'COMPLIMENTARY',
        hasEmail: Boolean(order.email),
        canBlocked: hasRole(session, ['EVENT_MANAGER']),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}

const bodySchema = z.object({
  tabId: z.uuid(),
  changes: seatChangeSchema,
  notify: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
  allowBlocked: z.boolean().default(false),
  expectedVersion: z.number().int().positive().optional(),
});

/** POST – moves the given items to the new (held / swapped / blocked) seats. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const orderId = uuidParam.parse((await params).id);
    const body = await parseBody(request, bodySchema);
    if (body.allowBlocked && !hasRole(session, ['EVENT_MANAGER'])) {
      throw new DomainError('FORBIDDEN', 'Not allowed', 403);
    }
    const core = getCore();
    const result = await changeOrderSeats(core, {
      orderId,
      changes: body.changes,
      userId: session.userId,
      holdSessionId: boxOfficeSessionId(session.userId, body.tabId),
      notify: body.notify,
      reason: body.reason ?? null,
      allowBlocked: body.allowBlocked,
      expectedVersion: body.expectedVersion,
    });
    // The change is committed: a failing audit write must never turn it into an error.
    try {
      await audit(core.db, session, 'order.seats_changed', 'order', orderId, {
        changes: result.changes.map((c) => ({
          orderItemId: c.orderItemId,
          from: c.from.seatId,
          to: c.to.seatId,
        })),
        reissuedTickets: result.reissuedTickets,
        notify: body.notify,
        reason: body.reason ?? null,
        allowBlocked: body.allowBlocked,
      });
    } catch (err) {
      console.error('[seat-change] audit entry failed after the change was committed', err);
    }
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
