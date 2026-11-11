import { revokeScannerDevice } from '@tix/core';
import { audit } from '@/server/admin/audit';
import { SCANNER_MANAGE_ROLES } from '@/server/admin/scanners';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** POST – revokes the device; its token stops working immediately. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_MANAGE_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const id = uuidParam.parse((await ctx.params).id);
    const core = getCore();
    await revokeScannerDevice(core, id);
    await audit(core.db, session, 'scanner.device_revoked', 'scanner_device', id);
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  });
}
