import { appLatestInfo, getSetting } from '@tix/core';
import { getCore } from '@/server/core';
import { deviceRoute, scannerError, scannerJson } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** GET – current app release (version, sha256, time-limited signed download URL); 404 when none is published. */
export async function GET(request: Request) {
  return deviceRoute(
    request,
    async () => {
      const core = getCore();
      const latest = await appLatestInfo(core);
      if (!latest) {
        // Source GITHUB: apps that support it never call this; older apps get the uploaded release if there is one.
        if ((await getSetting(core, 'scanner')).appUpdateSource === 'GITHUB') {
          return scannerError(
            'UPDATE_SOURCE_GITHUB',
            'App updates come from GitHub releases (see the manifest settings.appUpdate)',
            404,
          );
        }
        return scannerError('NO_RELEASE', 'No app release has been published', 404);
      }
      return scannerJson(latest);
    },
    { route: 'app-latest', perMinute: 30 },
  );
}
