import { getSystemStats } from '@tix/core';
import { NextResponse } from 'next/server';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – live system status (polled by /admin/system); cached for a few seconds across tabs. */
export async function GET() {
  return handle(async () => {
    const session = await adminForApi(['SUPER_ADMIN']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    return NextResponse.json(await getSystemStats(getCore()), {
      headers: { 'cache-control': 'no-store' },
    });
  });
}
