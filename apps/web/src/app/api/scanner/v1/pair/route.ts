import { exchangePairingCode } from '@tix/core';
import { SCANNER_API_VERSION, pairRequestSchema } from '@tix/shared';
import { getCore } from '@/server/core';
import { publicScannerRoute, readJsonBody, scannerJson } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** POST – exchanges a one-time pairing code for the device token (shown once). 10 per minute per IP. */
export async function POST(request: Request) {
  return publicScannerRoute('scanner-pair', 10, async () => {
    const body = await readJsonBody(request, pairRequestSchema, 8 * 1024);
    const paired = await exchangePairingCode(getCore(), body);
    return scannerJson(
      {
        apiVersion: SCANNER_API_VERSION,
        deviceId: paired.deviceId,
        deviceName: paired.deviceName,
        token: paired.token,
        serverTime: new Date().toISOString(),
      },
      201,
    );
  });
}
