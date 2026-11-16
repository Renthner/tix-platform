import { exportTicketTemplate } from '@tix/core';
import { TICKET_DESIGN_FILE_EXTENSION } from '@tix/shared';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** GET – downloads the design as a portable `.tixticket.json` file (no event / order data). */
export async function GET(_req: Request, { params }: Params) {
  return handle(async () => {
    if (!(await adminForApi(['EVENT_MANAGER']))) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await params).id);
    const file = await exportTicketTemplate(getCore(), id, {
      appVersion: process.env.npm_package_version ?? 'unknown',
    });
    const base =
      file.template.name
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 60) || 'ticket-design';
    return new Response(JSON.stringify(file), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${base}${TICKET_DESIGN_FILE_EXTENSION}"`,
        'cache-control': 'no-store',
      },
    });
  });
}
