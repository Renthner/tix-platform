import { deleteScannerDevice, updateScannerDevice } from '@tix/core';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { SCANNER_MANAGE_ROLES } from '@/server/admin/scanners';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle, parseBody, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    assignments: z
      .array(
        z.object({
          eventId: z.uuid(),
          entranceId: z.uuid().nullish(),
          allowCheckOut: z.boolean(),
        }),
      )
      .min(1)
      .max(50)
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.assignments !== undefined, {
    message: 'Nothing to change',
  });

/** PATCH – rename a device and/or replace its event assignments. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_MANAGE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await ctx.params).id);
    const body = await parseBody(request, patchSchema);
    const core = getCore();
    await updateScannerDevice(core, id, body);
    await audit(core.db, session, 'scanner.device_updated', 'scanner_device', id, {
      renamed: body.name ?? null,
      events: body.assignments?.map((a) => a.eventId) ?? null,
    });
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  });
}

/** DELETE – removes a revoked device from the list (archived; the scan history keeps its name). */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_MANAGE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const id = uuidParam.parse((await ctx.params).id);
    const core = getCore();
    await deleteScannerDevice(core, id);
    await audit(core.db, session, 'scanner.device_deleted', 'scanner_device', id);
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  });
}
