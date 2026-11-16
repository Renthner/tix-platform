import { exportEvent } from '@tix/core';
import { events } from '@tix/db';
import { EVENT_FILE_EXTENSION } from '@tix/shared';
import { eq } from 'drizzle-orm';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * GET – downloads the complete event as one portable `.tixevent.json` file (settings, plan,
 * prices, images …; no orders, tickets, customers, codes or signing keys).
 */
export async function GET(_req: Request, { params }: Params) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const id = uuidParam.parse((await params).id);
    const core = getCore();
    const [event] = await core.db
      .select({ slug: events.slug })
      .from(events)
      .where(eq(events.id, id));
    if (!event) return apiError('EVENT_NOT_FOUND', 'Event not found', 404);
    const file = await exportEvent(core, id, {
      appVersion: process.env.npm_package_version ?? 'unknown',
      includeEmailTemplates: session.roles.includes('SUPER_ADMIN'),
    });
    await audit(core.db, session, 'event.export', 'event', id, { slug: event.slug });
    return new Response(JSON.stringify(file), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${event.slug}${EVENT_FILE_EXTENSION}"`,
        'cache-control': 'no-store',
      },
    });
  });
}
