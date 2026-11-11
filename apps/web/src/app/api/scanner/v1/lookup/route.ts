import { lookupTickets } from '@tix/core';
import { lookupQuerySchema } from '@tix/shared';
import { getCore } from '@/server/core';
import { deviceRoute, queryOf, scannerJson } from '@/server/scanner-api';

export const dynamic = 'force-dynamic';

/** GET ?eventId&q&limit – manual lookup by name, ticket code, order number or seat. */
export async function GET(request: Request) {
  return deviceRoute(
    request,
    async ({ device }) => {
      const query = lookupQuerySchema.parse(queryOf(request));
      return scannerJson(await lookupTickets(getCore(), device, query));
    },
    { route: 'lookup', perMinute: 240 },
  );
}
