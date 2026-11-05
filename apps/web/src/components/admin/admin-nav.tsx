import type { AdminRole } from '@tix/shared';
import { getAdminSession, hasRole } from '@/server/auth';
import { AdminNavLinks, type NavKey } from './admin-nav-links';

/** Required roles per navigation entry (empty = every admin). SUPER_ADMIN sees everything. */
const ACCESS: [NavKey, AdminRole[]][] = [
  ['dashboard', []],
  ['events', ['EVENT_MANAGER']],
  ['venues', ['EVENT_MANAGER']],
  ['symbols', ['EVENT_MANAGER']],
  ['waitingRoom', ['EVENT_MANAGER']],
  ['settings', ['SUPER_ADMIN']],
];

/** Server component: filters the navigation by the signed-in admin's roles. */
export async function AdminNav() {
  const session = await getAdminSession();
  if (!session) return null;
  const keys = ACCESS.filter(([, roles]) => roles.length === 0 || hasRole(session, roles)).map(
    ([key]) => key,
  );
  return <AdminNavLinks keys={keys} />;
}
