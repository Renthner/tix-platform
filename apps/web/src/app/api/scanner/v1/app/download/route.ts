import { openApkForToken, APK_CONTENT_TYPE } from '@tix/core';
import { getCore } from '@/server/core';
import { publicScannerRoute } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** GET ?t=<signed token> – the APK. The signed, time-limited link is the credential (staff phones, update URL). */
export async function GET(request: Request) {
  return publicScannerRoute('scanner-apk', 20, async () => {
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const { release, stream } = await openApkForToken(getCore(), token);
    return new Response(stream, {
      headers: {
        'content-type': APK_CONTENT_TYPE,
        'content-length': String(release.sizeBytes),
        'content-disposition': `attachment; filename="tix-scanner-${release.versionName}.apk"`,
        'cache-control': 'no-store',
        'x-content-sha256': release.sha256,
      },
    });
  });
}
