import { importSeatMap, parseSeatMapFile } from '@tix/core';
import { SEAT_MAP_FILE_MAX_BYTES, summarizeSeatMapFile } from '@tix/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

const fields = z.object({
  mode: z.enum(['preview', 'import']),
  venueId: z.uuid(),
  name: z.string().trim().max(120).optional(),
});

/**
 * POST multipart (`file`, `mode`, `venueId`, `name`).
 *  - preview: validates the file and returns its summary (nothing is stored)
 *  - import: creates a new master plan of the venue → { seatMapId, … }
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > SEAT_MAP_FILE_MAX_BYTES + 64 * 1024) {
      return apiError('SEATMAP_FILE_TOO_LARGE', 'The plan file is too large', 413);
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !(file instanceof File)) {
      return apiError('SEATMAP_FILE_INVALID', 'The file is not a seat plan file', 422);
    }
    if (file.size > SEAT_MAP_FILE_MAX_BYTES) {
      return apiError('SEATMAP_FILE_TOO_LARGE', 'The plan file is too large', 413);
    }
    const input = fields.parse({
      mode: form.get('mode'),
      venueId: form.get('venueId'),
      name: (form.get('name') as string | null) || undefined,
    });
    const parsed = parseSeatMapFile(new Uint8Array(await file.arrayBuffer()));
    if (input.mode === 'preview') {
      return NextResponse.json(
        { summary: summarizeSeatMapFile(parsed) },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    const core = getCore();
    const result = await importSeatMap(core, {
      venueId: input.venueId,
      file: parsed,
      name: input.name,
      userId: session.userId,
    });
    await audit(core.db, session, 'seatmap.import', 'seat_map', result.seatMapId, {
      venueId: input.venueId,
      seats: result.seats,
    });
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
