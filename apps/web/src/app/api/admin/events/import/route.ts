import { eventTags, importEvent, parseEventFile } from '@tix/core';
import { EVENT_FILE_MAX_BYTES, summarizeEventFile } from '@tix/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { utcToZonedWallTime, zonedWallTimeToUtc } from '@/lib/datetime';
import { audit } from '@/server/admin/audit';
import { refreshShop } from '@/server/admin/shop-refresh';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle } from '@/server/http';
import { sanitizeRichText } from '@/server/rich-text';

export const dynamic = 'force-dynamic';

const fields = z.object({
  mode: z.enum(['preview', 'import']),
  venueId: z.uuid().optional(),
  title: z.string().trim().max(200).optional(),
  slug: z.string().trim().max(80).optional(),
  /** datetime-local in the time zone of the event file. */
  startsAt: z.string().trim().max(40).optional(),
  defaultTicketTypeName: z.string().trim().max(80).optional(),
});

/**
 * POST multipart (`file`, `mode`, `venueId`, `title`, `slug`, `startsAt`).
 *  - preview: validates the file and returns its summary (nothing is stored)
 *  - import: creates a new DRAFT event → { eventId, slug, warnings, seatPlan }
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > EVENT_FILE_MAX_BYTES + 64 * 1024) {
      return apiError('EVENT_FILE_TOO_LARGE', 'The event file is too large', 413);
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !(file instanceof File)) {
      return apiError('EVENT_FILE_INVALID', 'The file is not an event file', 422);
    }
    if (file.size > EVENT_FILE_MAX_BYTES) {
      return apiError('EVENT_FILE_TOO_LARGE', 'The event file is too large', 413);
    }
    const text = (name: string) => (form.get(name) as string | null) || undefined;
    const input = fields.parse({
      mode: form.get('mode'),
      venueId: text('venueId'),
      title: text('title'),
      slug: text('slug'),
      startsAt: text('startsAt'),
      defaultTicketTypeName: text('defaultTicketTypeName'),
    });
    const parsed = parseEventFile(new Uint8Array(await file.arrayBuffer()));
    if (input.mode === 'preview') {
      return NextResponse.json(
        {
          summary: summarizeEventFile(parsed),
          startsAtLocal: utcToZonedWallTime(new Date(parsed.event.startsAt), parsed.event.timeZone),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    // Admission-only events (file mode ADMISSION) may be imported without a venue.
    if (!input.venueId && parsed.event.seatingMode !== 'ADMISSION') {
      return apiError('VALIDATION_FAILED', 'A venue is required', 422);
    }
    let startsAt: Date | null = null;
    if (input.startsAt) {
      startsAt = zonedWallTimeToUtc(input.startsAt, parsed.event.timeZone);
      if (!startsAt) return apiError('INVALID_DATES', 'The start date is invalid', 400);
    }
    const core = getCore();
    const result = await importEvent(core, {
      file: parsed,
      venueId: input.venueId ?? null,
      userId: session.userId,
      title: input.title,
      slug: input.slug ?? null,
      startsAt,
      sanitizeRichText,
      // E-mail templates are SUPER_ADMIN territory (see server/admin/email-templates.ts).
      includeEmailTemplates: session.roles.includes('SUPER_ADMIN'),
      defaultTicketTypeName: input.defaultTicketTypeName || 'Standard',
    });
    await audit(core.db, session, 'event.import', 'event', result.eventId, {
      title: input.title ?? parsed.event.title,
      slug: result.slug,
      venueId: input.venueId ?? null,
      warnings: result.warnings.length,
    });
    await refreshShop(eventTags(result.eventId)).catch(() => {});
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
