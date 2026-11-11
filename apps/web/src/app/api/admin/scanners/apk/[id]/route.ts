import { deleteApkRelease, setCurrentApkRelease } from '@tix/core';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { SCANNER_APK_ROLES } from '@/server/admin/scanners';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle, parseBody, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** PATCH `{ current: true }` – publishes this release as the current one. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_APK_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await ctx.params).id);
    await parseBody(request, z.object({ current: z.literal(true) }));
    const core = getCore();
    await setCurrentApkRelease(core, id);
    await audit(core.db, session, 'scanner.apk_published', 'scanner_apk_release', id);
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  });
}

/** DELETE – removes a release that is not the current one. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_APK_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const id = uuidParam.parse((await ctx.params).id);
    const core = getCore();
    await deleteApkRelease(core, id);
    await audit(core.db, session, 'scanner.apk_deleted', 'scanner_apk_release', id);
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  });
}
