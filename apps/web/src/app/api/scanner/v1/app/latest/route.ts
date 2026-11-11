import { appLatestInfo } from '@tix/core';
import { getCore } from '@/server/core';
import { deviceRoute, scannerError, scannerJson } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** GET – current app release (version, sha256, time-limited signed download URL); 404 when none is published. */
export async function GET(request: Request) {
  return deviceRoute(
    request,
    async () => {
      const latest = await appLatestInfo(getCore());
      if (!latest) return scannerError('NO_RELEASE', 'No app release has been published', 404);
      return scannerJson(latest);
    },
    { route: 'app-latest', perMinute: 30 },
  );
}
