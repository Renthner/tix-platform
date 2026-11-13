import { clearMetricsToken, generateMetricsToken, isMetricsEnabled } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ action: z.enum(['generate', 'clear']) });

/** GET – whether the Prometheus endpoint is enabled (a token is set). Never returns the token. */
export async function GET() {
  return handle(async () => {
    const session = await adminForApi(['SUPER_ADMIN']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    return NextResponse.json(
      { enabled: await isMetricsEnabled(getCore()) },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}

/** POST – generates a new token (returned once, replaces the old one) or removes it (disables /api/metrics). */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['SUPER_ADMIN']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const { action } = await parseBody(request, bodySchema);
    const core = getCore();
    let token: string | undefined;
    if (action === 'generate') token = await generateMetricsToken(core, session.userId);
    else await clearMetricsToken(core);
    await audit(core.db, session, 'settings.update', 'system_setting', 'metrics.credentials', {
      secret: {
        key: 'metrics.credentials',
        change: action === 'generate' ? 'replaced' : 'removed',
      },
    });
    return NextResponse.json(
      { enabled: action === 'generate', ...(token ? { token } : {}) },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
