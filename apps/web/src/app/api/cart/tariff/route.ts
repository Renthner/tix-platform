import { getEventCached, setTariff } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { handle, parseBody } from '@/server/http';
import { ensureSessionId } from '@/server/session';

export const dynamic = 'force-dynamic';

const body = z.object({
  eventId: z.uuid(),
  itemKey: z.string().min(1).max(100),
  ticketTypeId: z.uuid(),
});

/** PATCH – chooses the tariff (normal / reduced …) of one cart item. */
export async function PATCH(request: Request) {
  return handle(async () => {
    const core = getCore();
    const { eventId, itemKey, ticketTypeId } = await parseBody(request, body);
    const event = await getEventCached(core, eventId);
    await setTariff(core, await ensureSessionId(), event, itemKey, ticketTypeId);
    return NextResponse.json({ ok: true });
  });
}
