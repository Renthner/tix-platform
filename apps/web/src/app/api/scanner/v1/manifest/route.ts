import { buildManifest } from '@tix/core';
import { getCore } from '@/server/core';
import { deviceRoute, scannerJson } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** GET – assigned events with keys, tariffs, entrances, LAN secret and settings. Supports If-None-Match. */
export async function GET(request: Request) {
  return deviceRoute(
    request,
    async ({ device }) => {
      const manifest = await buildManifest(getCore(), device);
      const etag = `"${manifest.etag}"`;
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } });
      }
      return scannerJson(manifest, 200, { etag });
    },
    { route: 'manifest', perMinute: 120 },
  );
}
