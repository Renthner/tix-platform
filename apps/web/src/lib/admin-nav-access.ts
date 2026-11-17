import type { AdminRole } from '@tix/shared';
import type { NavKey } from '@/components/admin/admin-nav-links';

/**
 * Required roles per admin navigation entry (empty = every admin). SUPER_ADMIN sees everything.
 * Shared by the admin sidebar and the shop header's dashboard menu.
 */
export const NAV_ACCESS: readonly (readonly [NavKey, readonly AdminRole[]])[] = [
  // Same order as the sidebar sections (NAV_GROUPS in admin-nav-links.tsx).
  ['dashboard', []],
  ['boxOffice', ['EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF']],
  ['orders', ['FINANCE', 'EVENT_MANAGER']],
  ['customers', ['FINANCE', 'EVENT_MANAGER']],
  ['discounts', ['FINANCE', 'EVENT_MANAGER']],
  ['refunds', ['FINANCE']],
  ['statistics', ['FINANCE', 'EVENT_MANAGER']],
  ['events', ['EVENT_MANAGER']],
  ['venues', ['EVENT_MANAGER']],
  ['waitingRoom', ['EVENT_MANAGER']],
  ['scanners', ['EVENT_MANAGER', 'DOOR_STAFF']],
  ['ticketTemplates', ['EVENT_MANAGER']],
  ['emailTemplates', ['SUPER_ADMIN']],
  ['media', ['EVENT_MANAGER']],
  ['symbols', ['EVENT_MANAGER']],
  ['banking', ['FINANCE']],
  ['paypal', ['SUPER_ADMIN']],
  ['accounting', ['FINANCE']],
  ['fees', ['FINANCE', 'EVENT_MANAGER']],
  ['users', ['SUPER_ADMIN']],
  ['backups', ['SUPER_ADMIN']],
  ['system', ['SUPER_ADMIN']],
  ['audit', ['SUPER_ADMIN']],
  ['settings', ['SUPER_ADMIN']],
];

/** Navigation entries a user with these roles may open (same rule as `hasRole`). */
export function allowedNavKeys(roles: readonly AdminRole[]): NavKey[] {
  const isSuper = roles.includes('SUPER_ADMIN');
  return NAV_ACCESS.filter(
    ([, required]) => required.length === 0 || isSuper || required.some((r) => roles.includes(r)),
  ).map(([key]) => key);
}
