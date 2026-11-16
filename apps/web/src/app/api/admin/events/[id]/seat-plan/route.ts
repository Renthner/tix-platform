import { eventTags, parseSeatMapFile, replaceEventSeatPlan } from '@tix/core';
import { SEAT_MAP_FILE_MAX_BYTES, summarizeSeatMapFile } from '@tix/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { refreshShop } from '@/server/admin/shop-refresh';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const fields = z.object({
  mode: z.enum(['preview', 'replace']),
  source: z.enum(['template', 'file']),
  seatMapId: z.uuid().optional(),
});

/**
 * POST multipart (`mode`, `source`, `seatMapId` | `file`) – replaces the seat plan of a DRAFT event
 * by a copy of a venue plan or by an imported plan file.
 *  - preview (file only): validates the file and returns its summary
 *  - replace: swaps the plan → { seatMapId, categoriesReused, categoriesCreated, unassignedSeats }
 */
export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const eventId = uuidParam.parse((await params).id);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > SEAT_MAP_FILE_MAX_BYTES + 64 * 1024) {
      return apiError('SEATMAP_FILE_TOO_LARGE', 'The plan file is too large', 413);
    }
    const form = await request.formData().catch(() => null);
    if (!form) return apiError('VALIDATION_FAILED', 'Invalid request', 422);
    const input = fields.parse({
      mode: form.get('mode'),
      source: form.get('source'),
      seatMapId: (form.get('seatMapId') as string | null) || undefined,
    });
    const core = getCore();

    if (input.source === 'file') {
      const file = form.get('file');
      if (!(file instanceof File)) {
        return apiError('SEATMAP_FILE_INVALID', 'The file is not a seat plan file', 422);
      }
      if (file.size > SEAT_MAP_FILE_MAX_BYTES) {
        return apiError('SEATMAP_FILE_TOO_LARGE', 'The plan file is too large', 413);
      }
      const parsed = parseSeatMapFile(new Uint8Array(await file.arrayBuffer()));
      if (input.mode === 'preview') {
        return NextResponse.json(
          { summary: summarizeSeatMapFile(parsed) },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      const result = await replaceEventSeatPlan(core, {
        eventId,
        source: { kind: 'file', file: parsed },
        userId: session.userId,
        // Audited in the transaction of the swap.
        audit: (tx, r) =>
          audit(tx, session, 'event.seatplan.replace', 'event', eventId, {
            source: 'file',
            seatMapId: r.seatMapId,
            categoriesCreated: r.categoriesCreated,
            unassignedSeats: r.unassignedSeats,
            scannerEntrancesCleared: r.scannerEntrancesCleared,
          }),
      });
      await refreshShop(eventTags(eventId)).catch(() => {});
      return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
    }

    if (input.mode === 'preview' || !input.seatMapId) {
      return apiError('VALIDATION_FAILED', 'A plan is required', 422);
    }
    const seatMapId = input.seatMapId;
    const result = await replaceEventSeatPlan(core, {
      eventId,
      source: { kind: 'template', seatMapId: input.seatMapId },
      userId: session.userId,
      audit: (tx, r) =>
        audit(tx, session, 'event.seatplan.replace', 'event', eventId, {
          source: 'template',
          templateId: seatMapId,
          seatMapId: r.seatMapId,
          categoriesCreated: r.categoriesCreated,
          unassignedSeats: r.unassignedSeats,
          scannerEntrancesCleared: r.scannerEntrancesCleared,
        }),
    });
    await refreshShop(eventTags(eventId)).catch(() => {});
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
