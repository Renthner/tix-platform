import { syncTickets } from '@tix/core';
import { syncQuerySchema } from '@tix/shared';
import { getCore } from '@/server/core';
import { deviceRoute, queryOf, scannerJson } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** GET ?eventId&since&limit – one page of ticket changes ordered by sync_version (tombstones included). */
export async function GET(request: Request) {
  return deviceRoute(
    request,
    async ({ device }) => {
      const query = syncQuerySchema.parse(queryOf(request));
      return scannerJson(await syncTickets(getCore(), device, query));
    },
    { route: 'sync', perMinute: 120 },
  );
}
