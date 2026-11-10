import { readMaintenance } from '@/server/maintenance-gate';

export const dynamic = 'force-dynamic';

/** Public, Redis-only: is a restore running and which step? (polled by the maintenance page) */
export async function GET() {
  const state = await readMaintenance();
  return Response.json(
    { active: state.active, step: state.step ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
}
