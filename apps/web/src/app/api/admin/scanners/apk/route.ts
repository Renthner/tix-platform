import { APK_MAX_BYTES, registerApkRelease } from '@tix/core';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { SCANNER_APK_ROLES } from '@/server/admin/scanners';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

const fieldsSchema = z.object({
  versionName: z.string().trim().min(1).max(40),
  versionCode: z.coerce.number().int().min(1).max(2_100_000_000),
  notes: z.string().trim().max(2_000).optional(),
  makeCurrent: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

/**
 * POST multipart/form-data `file` (signed APK) + `versionName`, `versionCode`, `notes`,
 * `makeCurrent`. The version data is entered by the admin (the binary manifest is not parsed).
 * A route handler: APKs exceed the server-action body limit.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_APK_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > APK_MAX_BYTES + 1024 * 1024) {
      return apiError('APK_TOO_LARGE', 'The APK is too large', 413);
    }
    const form = await request.formData().catch(() => null);
    if (!form) return apiError('INVALID_BODY', 'Multipart body expected', 400);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return apiError('FILE_REQUIRED', 'No file uploaded', 422);
    }
    if (file.size > APK_MAX_BYTES) return apiError('APK_TOO_LARGE', 'The APK is too large', 413);
    const fields = fieldsSchema.parse({
      versionName: form.get('versionName') ?? '',
      versionCode: form.get('versionCode') ?? '',
      notes: form.get('notes') ?? undefined,
      makeCurrent: form.get('makeCurrent') ?? undefined,
    });
    const core = getCore();
    const release = await registerApkRelease(core, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      versionName: fields.versionName,
      versionCode: fields.versionCode,
      notes: fields.notes,
      makeCurrent: fields.makeCurrent,
      uploadedByUserId: session.userId,
    });
    await audit(core.db, session, 'scanner.apk_uploaded', 'scanner_apk_release', release.id, {
      versionName: release.versionName,
      versionCode: release.versionCode,
      sha256: release.sha256,
    });
    return Response.json(
      { id: release.id, versionName: release.versionName, versionCode: release.versionCode },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  });
}
