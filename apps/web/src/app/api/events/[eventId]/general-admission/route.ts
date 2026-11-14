import { setGeneralAdmission } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handle, parseBody } from '@/server/http';
import { ensureSessionId } from '@/server/session';
import { authorizeShopMutation, loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

const body = z.object({ sectionId: z.uuid(), quantity: z.number().int().min(0).max(100) });

/** PUT – sets the number of standing spots held in a GA section. */
export async function PUT(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event, actor } = await loadShopEvent((await params).eventId);
    const { sectionId, quantity } = await parseBody(request, body);
    // Reducing is always allowed; increasing requires a valid pass.
    const sid =
      quantity > 0 ? await authorizeShopMutation(core, event, actor) : await ensureSessionId();
    const result = await setGeneralAdmission(core, sid, event, sectionId, quantity);
    return NextResponse.json(result);
  });
}
