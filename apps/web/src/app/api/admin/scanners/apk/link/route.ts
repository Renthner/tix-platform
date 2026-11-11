import {
  APK_STAFF_LINK_TTL_SECONDS,
  apkDownloadUrl,
  createApkDownloadToken,
  getCurrentApkRelease,
  getSetting,
  githubStaffDownloadUrl,
  qrDataUrl,
} from '@tix/core';
import { SCANNER_VIEW_ROLES } from '@/server/admin/scanners';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, assertSameOrigin, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * POST – download link (+ QR code) for staff phones: a signed, time-limited link to the current uploaded APK
 * (source SERVER) or the GitHub release page of the default channel (source GITHUB; no expiry).
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(SCANNER_VIEW_ROLES);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    assertSameOrigin(request);
    const core = getCore();
    const github = (await getSetting(core, 'scanner')).appUpdateSource === 'GITHUB';
    if (github) {
      // Public GitHub page: no signed link, no expiry.
      const url = await githubStaffDownloadUrl(core);
      if (url) {
        return Response.json(
          { url, qrDataUrl: qrDataUrl(url), expiresAt: null },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
    }
    if (!(await getCurrentApkRelease(core))) {
      // GITHUB without a repository on the server and without an upload: nothing to link to.
      return github
        ? apiError('NO_REPOSITORY', 'Set the GitHub repository in the scanner settings', 404)
        : apiError('NO_RELEASE', 'No app release has been published', 404);
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
