import { createPairingCode, qrDataUrl } from '@tix/core';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { SCANNER_MANAGE_ROLES } from '@/server/admin/scanners';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  label: z.string().trim().max(80).optional(),
  assignments: z
    .array(
      z.object({
        eventId: z.uuid(),
        entranceId: z.uuid().nullish(),
        allowCheckOut: z.boolean(),
      }),
    )
    .min(1)
    .max(20),
});

/** POST – creates a one-time pairing code (QR + human code) for new scanner devices. */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_MANAGE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const body = await parseBody(request, bodySchema);
    const core = getCore();
    const created = await createPairingCode(core, {
      createdByUserId: session.userId,
      label: body.label,
      assignments: body.assignments,
    });
    await audit(
      core.db,
      session,
      'scanner.pairing_code_created',
      'scanner_pairing_code',
      created.id,
      { events: body.assignments.map((a) => a.eventId) },
    );
    return Response.json(
      {
        id: created.id,
        code: created.code,
        serverUrl: created.serverUrl,
        expiresAt: created.expiresAt.toISOString(),
        qrDataUrl: qrDataUrl(created.qrPayload),
      },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  });
}
