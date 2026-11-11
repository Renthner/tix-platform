import type { AdminRole } from '@tix/shared';
import type { NavKey } from '@/components/admin/admin-nav-links';

/**
 * Required roles per admin navigation entry (empty = every admin). SUPER_ADMIN sees everything.
 * Shared by the admin sidebar and the shop header's dashboard menu.
 */
export const NAV_ACCESS: readonly (readonly [NavKey, readonly AdminRole[]])[] = [
  ['dashboard', []],
  ['boxOffice', ['EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF']],
  ['events', ['EVENT_MANAGER']],
  ['orders', ['FINANCE', 'EVENT_MANAGER']],
  ['customers', ['FINANCE', 'EVENT_MANAGER']],
  ['banking', ['FINANCE']],
  ['refunds', ['FINANCE']],
  ['accounting', ['FINANCE']],
  ['fees', ['FINANCE', 'EVENT_MANAGER']],
  ['emailTemplates', ['SUPER_ADMIN']],
  ['ticketTemplates', ['EVENT_MANAGER']],
  ['venues', ['EVENT_MANAGER']],
  ['media', ['EVENT_MANAGER']],
  ['symbols', ['EVENT_MANAGER']],
  ['waitingRoom', ['EVENT_MANAGER']],
  ['scanners', ['EVENT_MANAGER', 'DOOR_STAFF']],
  ['users', ['SUPER_ADMIN']],
  ['backups', ['SUPER_ADMIN']],
  ['settings', ['SUPER_ADMIN']],
];

/** Navigation entries a user with these roles may open (same rule as `hasRole`). */
export function allowedNavKeys(roles: readonly AdminRole[]): NavKey[] {
  const isSuper = roles.includes('SUPER_ADMIN');
  return NAV_ACCESS.filter(
    ([, required]) => required.length === 0 || isSuper || required.some((r) => roles.includes(r)),
  ).map(([key]) => key);
}
