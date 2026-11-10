import { exportCustomerDataAudited } from '@tix/core';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, clientIp, handle, uuidParam } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – GDPR Art. 15 export of everything stored about a customer (JSON download, audited). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await adminForApi(['FINANCE']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const customerId = uuidParam.parse((await params).id);
    const ip = await clientIp();
    const data = await exportCustomerDataAudited(
      getCore(),
      { userId: session.userId, ipAddress: ip === '0.0.0.0' ? null : ip },
      customerId,
    );
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="customer-${customerId}.json"`,
        'cache-control': 'no-store',
      },
    });
  });
}
