import { uploadOfflineScans } from '@tix/core';
import { scanBatchRequestSchema } from '@tix/shared';
import { getCore } from '@/server/core';
import { deviceRoute, readJsonBody, scannerJson } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** POST – upload of scans taken offline (max 200, idempotent); one decision per scan in request order. */
export async function POST(request: Request) {
  return deviceRoute(
    request,
    async ({ device }) => {
      const body = await readJsonBody(request, scanBatchRequestSchema, 512 * 1024);
      const results = await uploadOfflineScans(getCore(), device, body.scans, {
        sentAt: body.sentAt,
      });
      return scannerJson({ results, serverTime: new Date().toISOString() });
    },
    { route: 'batch', perMinute: 60 },
  );
}
