import {
  getBoxOfficeHold,
  holdBoxOfficeSeats,
  releaseBoxOfficeHold,
  releaseBoxOfficeSeats,
  setBoxOfficeStandingHold,
} from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { BOX_OFFICE_ROLES } from '@/server/admin/box-office';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const base = { eventId: z.uuid(), tabId: z.uuid() };
const holdSchema = z.discriminatedUnion('op', [
  z.object({ ...base, op: z.literal('add'), seatIds: z.array(z.uuid()).min(1).max(200) }),
  z.object({ ...base, op: z.literal('remove'), seatIds: z.array(z.uuid()).min(1).max(200) }),
  z.object({
    ...base,
    op: z.literal('standing'),
    sectionId: z.uuid(),
    quantity: z.number().int().min(0).max(1000),
  }),
  z.object({ ...base, op: z.literal('release') }),
]);

/** GET – the seats / standing spots the tab holds right now (restores the page after navigation). */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi(BOX_OFFICE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const query = z
      .object(base)
      .parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    const result = await getBoxOfficeHold(getCore(), {
      userId: session.userId,
      tabId: query.tabId,
      eventId: query.eventId,
    });
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}

/**
 * POST – holds / releases the seller's picks with real seat locks (normal cart lock TTL), so an
 * online buyer cannot take them. One lock session per admin tab.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(BOX_OFFICE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const body = await parseBody(request, holdSchema);
    const core = getCore();
    const ref = { userId: session.userId, tabId: body.tabId, eventId: body.eventId };
    let result: Record<string, unknown> = {};
    switch (body.op) {
      case 'add':
        result = await holdBoxOfficeSeats(core, { ...ref, seatIds: body.seatIds });
        break;
      case 'remove':
        await releaseBoxOfficeSeats(core, { ...ref, seatIds: body.seatIds });
        break;
      case 'standing':
        result = await setBoxOfficeStandingHold(core, {
          ...ref,
          sectionId: body.sectionId,
          quantity: body.quantity,
        });
        break;
      case 'release':
        await releaseBoxOfficeHold(core, ref);
        break;
    }
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
