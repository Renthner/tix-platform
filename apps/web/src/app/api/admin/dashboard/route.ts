import { NextResponse } from 'next/server';
import { loadDashboard, parseStatusesParam } from '@/server/admin/dashboard';
import { adminForApi } from '@/server/auth';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – live dashboard telemetry, filtered by the caller's admin roles (polled by the dashboard; `?statuses=` = status filter). */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi();
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    return NextResponse.json(
      await loadDashboard(
        session,
        parseStatusesParam(new URL(request.url).searchParams.get('statuses')),
      ),
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  });
}
