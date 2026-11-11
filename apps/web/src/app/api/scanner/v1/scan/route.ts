import { scanOnline } from '@tix/core';
import { scanRequestSchema } from '@tix/shared';
import { getCore } from '@/server/core';
import { deviceRoute, readJsonBody, scannerJson } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** POST – one online scan (check-in / check-out); idempotent per clientScanId. */
export async function POST(request: Request) {
  return deviceRoute(
    request,
    async ({ device }) => {
      const scan = await readJsonBody(request, scanRequestSchema, 8 * 1024);
      return scannerJson(await scanOnline(getCore(), device, scan));
    },
    { route: 'scan', perMinute: 600 },
  );
}
