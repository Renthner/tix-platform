import {
  afterSeatMapSaved,
  getSeatMapMeta,
  loadSeatMapDocument,
  saveSeatMapDocument,
} from '@tix/core';
import { NextResponse } from 'next/server';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** GET – current editor document of a seat map. */
export async function GET(_req: Request, { params }: Params) {
  return handle(async () => {
    if (!(await adminForApi(['EVENT_MANAGER']))) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await params).id);
    const doc = await loadSeatMapDocument(getCore().db, id);
    if (!doc) return apiError('NOT_FOUND', 'Seat map not found', 404);
    return NextResponse.json(doc, { headers: { 'cache-control': 'no-store' } });
  });
}

/**
 * PUT – saves the complete editor document (optimistic concurrency via `version`).
 * 200 { version } | 404/409/422 { error: SeatMapSaveError }
 */
export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const id = uuidParam.parse((await params).id);
    const core = getCore();
    if (!(await getSeatMapMeta(core.db, id)))
      return apiError('NOT_FOUND', 'Seat map not found', 404);
    const body: unknown = await request.json().catch(() => null);
    const result = await saveSeatMapDocument(core.db, id, body, session.userId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    await afterSeatMapSaved(core, result);
    return NextResponse.json({ version: result.version });
  });
}
