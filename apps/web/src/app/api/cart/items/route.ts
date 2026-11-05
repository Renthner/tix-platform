import { getEventCached, removeCartItem } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { handle, parseBody } from '@/server/http';
import { ensureSessionId } from '@/server/session';

export const dynamic = 'force-dynamic';

const body = z.object({ eventId: z.uuid(), itemKey: z.string().min(1).max(100) });

/** DELETE – removes a single seat or standing spot from the cart. */
export async function DELETE(request: Request) {
  return handle(async () => {
    const core = getCore();
    const { eventId, itemKey } = await parseBody(request, body);
    const event = await getEventCached(core, eventId);
    await removeCartItem(core, await ensureSessionId(), event, itemKey);
    return NextResponse.json({ ok: true });
  });
}
