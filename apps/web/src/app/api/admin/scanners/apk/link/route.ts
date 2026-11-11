import {
  APK_STAFF_LINK_TTL_SECONDS,
  apkDownloadUrl,
  createApkDownloadToken,
  getCurrentApkRelease,
  qrDataUrl,
} from '@tix/core';
import { SCANNER_VIEW_ROLES } from '@/server/admin/scanners';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** POST – signed, time-limited download link (+ QR code) of the current APK for staff phones. */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_VIEW_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const core = getCore();
    if (!(await getCurrentApkRelease(core))) {
      return apiError('NO_RELEASE', 'No app release has been published', 404);
    }
    const url = await apkDownloadUrl(core, createApkDownloadToken(core, 'current'));
    return Response.json(
      {
        url,
        qrDataUrl: qrDataUrl(url),
        expiresAt: new Date(Date.now() + APK_STAFF_LINK_TTL_SECONDS * 1000).toISOString(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
