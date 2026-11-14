import { bestAvailable } from '@tix/core';
import { MAX_SEATS_PER_REQUEST } from '@tix/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handle, parseBody } from '@/server/http';
import { authorizeShopMutation, loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

const body = z.object({
  categoryId: z.uuid(),
  quantity: z.number().int().min(1).max(MAX_SEATS_PER_REQUEST),
});

/** POST – finds and atomically locks the best adjacent seats of a category. */
export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event, actor } = await loadShopEvent((await params).eventId);
    const sid = await authorizeShopMutation(core, event, actor);
    const { categoryId, quantity } = await parseBody(request, body);
    return NextResponse.json(await bestAvailable(core, sid, event, categoryId, quantity));
  });
}
