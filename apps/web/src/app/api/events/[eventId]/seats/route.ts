import { addSeats, removeSeats } from '@tix/core';
import { MAX_SEATS_PER_REQUEST } from '@tix/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handle, parseBody } from '@/server/http';
import { ensureSessionId } from '@/server/session';
import { authorizeShopMutation, loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

const body = z.object({ seatIds: z.array(z.uuid()).min(1).max(MAX_SEATS_PER_REQUEST) });

/** POST – lock seats into the cart (atomic, all-or-nothing). */
export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    const sid = await authorizeShopMutation(core, event);
    const { seatIds } = await parseBody(request, body);
    const { expiresAt } = await addSeats(core, sid, event, seatIds);
    return NextResponse.json({ seatIds, expiresAt });
  });
}

/** DELETE – release own seats (no pass required: leaving must always be possible). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    const sid = await ensureSessionId();
    const { seatIds } = await parseBody(request, body);
    await removeSeats(core, sid, event.id, seatIds);
    return NextResponse.json({ released: seatIds });
  });
}
