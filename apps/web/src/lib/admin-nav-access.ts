import type { AdminRole } from '@tix/shared';
import { buildSidebar, type NavKey, type SidebarItem } from '@/lib/admin-nav-model';
import { SETTINGS_ROLES, SETTINGS_TAB_ROLES } from '@/lib/settings-tabs';

/**
 * Required roles per admin navigation entry (empty = every admin). SUPER_ADMIN sees everything.
 * Shared by the admin sidebar, the search palette and the shop header's dashboard menu.
 */
export const NAV_ACCESS: readonly (readonly [NavKey, readonly AdminRole[]])[] = [
  // Sidebar order first (SIDEBAR_GROUPS in admin-nav-model.ts), then the pages behind the hubs.
  ['dashboard', []],
  ['events', ['EVENT_MANAGER']],
  ['venues', ['EVENT_MANAGER']],
  ['orders', ['FINANCE', 'EVENT_MANAGER']],
  ['customers', ['FINANCE', 'EVENT_MANAGER']],
  ['discounts', ['FINANCE', 'EVENT_MANAGER']],
  ['refunds', ['FINANCE']],
  ['statistics', ['FINANCE', 'EVENT_MANAGER']],
  ['boxOffice', ['EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF']],
  ['door', ['EVENT_MANAGER', 'DOOR_STAFF']],
  ['cashUp', ['FINANCE', 'EVENT_MANAGER', 'DOOR_STAFF']],
  ['scanners', ['EVENT_MANAGER', 'DOOR_STAFF']],
  ['banking', ['FINANCE']],
  ['accounting', ['FINANCE']],
  // Hubs. Design: event managers see the libraries, super admins everything. Settings: the overview
  // lists only the pages the user may open (SETTINGS_TAB_ROLES in settings-tabs.ts).
  ['design', ['EVENT_MANAGER']],
  ['settings', SETTINGS_ROLES],
  ['administration', ['SUPER_ADMIN']],
  ['ticketTemplates', ['EVENT_MANAGER']],
  ['emailTemplates', ['SUPER_ADMIN']],
  ['media', ['EVENT_MANAGER']],
  ['symbols', ['EVENT_MANAGER']],
  ['fees', SETTINGS_TAB_ROLES.fees],
  ['waitingRoom', SETTINGS_TAB_ROLES.waitingRoom],
  ['users', ['SUPER_ADMIN']],
  ['backups', ['SUPER_ADMIN']],
  ['system', ['SUPER_ADMIN']],
  ['audit', ['SUPER_ADMIN']],
];

/** Navigation entries a user with these roles may open (same rule as `hasRole`). */
export function allowedNavKeys(roles: readonly AdminRole[]): NavKey[] {
  const isSuper = roles.includes('SUPER_ADMIN');
  return NAV_ACCESS.filter(
    ([, required]) => required.length === 0 || isSuper || required.some((r) => roles.includes(r)),
  ).map(([key]) => key);
}

/** The sidebar's top-level entries for these roles, in display order (hubs resolved). */
export function allowedSidebarItems(roles: readonly AdminRole[]): SidebarItem[] {
  return buildSidebar(allowedNavKeys(roles)).flatMap((s) => s.items);
}
