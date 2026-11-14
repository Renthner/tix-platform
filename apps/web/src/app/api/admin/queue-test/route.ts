import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { adminForApi } from '@/server/auth';
import { apiError, handle, parseBody } from '@/server/http';
import { cookieDefaults } from '@/server/session';
import { QUEUE_TEST_COOKIE } from '@/server/shop-actor';

export const dynamic = 'force-dynamic';

const body = z.object({ enabled: z.boolean() });

/**
 * POST { enabled } – a super-admin switches "test the waiting room" on or off. While on, the
 * automatic queue bypass of super-admins is disabled and the admin queues like a customer.
 * Session cookie (no max-age): it ends with the browser session. The role is checked here and on
 * every shop request that reads the cookie.
 */
export async function POST(request: Request) {
  return handle(async () => {
    // Origin check first (CSRF), then the role.
    const { enabled } = await parseBody(request, body);
    const session = await adminForApi(['SUPER_ADMIN']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const jar = await cookies();
    if (enabled) {
      const { maxAge: _maxAge, ...options } = cookieDefaults(0);
      jar.set(QUEUE_TEST_COOKIE, '1', options);
    } else {
      jar.delete(QUEUE_TEST_COOKIE);
    }
    return NextResponse.json({ enabled }, { headers: { 'cache-control': 'no-store' } });
  });
}
