import { deletePairingCode, getPairingCodeStatus } from '@tix/core';
import { audit } from '@/server/admin/audit';
import { SCANNER_MANAGE_ROLES } from '@/server/admin/scanners';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – pairing status (the admin dialog polls until the device has paired). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_MANAGE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await ctx.params).id);
    const status = await getPairingCodeStatus(getCore(), id);
    return Response.json(
      { ...status, expiresAt: status.expiresAt.toISOString() },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}

/** DELETE – invalidates an unused pairing code. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_MANAGE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const id = uuidParam.parse((await ctx.params).id);
    const core = getCore();
    await deletePairingCode(core, id);
    await audit(core.db, session, 'scanner.pairing_code_deleted', 'scanner_pairing_code', id);
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  });
}
