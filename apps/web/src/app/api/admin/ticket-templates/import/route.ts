import { importTicketTemplate, parseTicketDesignFile } from '@tix/core';
import { TICKET_DESIGN_FILE_MAX_BYTES, summarizeTicketDesignFile } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

const fields = z.object({
  mode: z.enum(['preview', 'import']),
  eventId: z.uuid().optional(),
  name: z.string().trim().max(120).optional(),
  /** Event imports only: `event` | `none` | a price category id. */
  assignTo: z.union([z.enum(['event', 'none']), z.uuid()]).default('none'),
});

/**
 * POST multipart (`file`, `mode`, `eventId`, `name`, `assignTo`).
 *  - preview: validates the file and returns its summary (nothing is stored)
 *  - import: creates a new template (library, or owned by `eventId`) → { templateId, … }
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > TICKET_DESIGN_FILE_MAX_BYTES + 64 * 1024) {
      return apiError('TICKET_DESIGN_FILE_TOO_LARGE', 'The design file is too large', 413);
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !(file instanceof File)) {
      return apiError('TICKET_DESIGN_FILE_INVALID', 'The file is not a ticket design', 422);
    }
    if (file.size > TICKET_DESIGN_FILE_MAX_BYTES) {
      return apiError('TICKET_DESIGN_FILE_TOO_LARGE', 'The design file is too large', 413);
    }
    const input = fields.parse({
      mode: form.get('mode'),
      eventId: (form.get('eventId') as string | null) || undefined,
      name: (form.get('name') as string | null) || undefined,
      assignTo: (form.get('assignTo') as string | null) || undefined,
    });
    const parsed = parseTicketDesignFile(new Uint8Array(await file.arrayBuffer()));
    if (input.mode === 'preview') {
      return NextResponse.json(
        { summary: summarizeTicketDesignFile(parsed) },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    const core = getCore();
    const result = await importTicketTemplate(core, {
      file: parsed,
      eventId: input.eventId,
      name: input.name,
      userId: session.userId,
      // Validated before anything is stored; undone if the assignment fails.
      assignTo: input.assignTo,
    });
    await audit(core.db, session, 'ticketTemplate.import', 'ticket_template', result.templateId, {
      eventId: input.eventId ?? null,
      assignTo: input.eventId ? input.assignTo : null,
      images: result.images,
    });
    revalidatePath('/', 'layout');
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
