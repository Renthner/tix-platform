/**
 * Structure of the admin navigation (no icons, no React): page keys and URLs, the sidebar
 * sections, the hub pages ("Design", "Settings", "System") with the pages they bundle and the
 * rule which sidebar entry is highlighted for a URL. Shared by the server (role filter, badges,
 * search index) and the client (sidebar, mobile menu).
 */
export const NAV_HREFS = {
  dashboard: '/admin',
  events: '/admin/events',
  venues: '/admin/venues',
  orders: '/admin/orders',
  customers: '/admin/customers',
  discounts: '/admin/discounts',
  refunds: '/admin/refunds',
  statistics: '/admin/statistics',
  boxOffice: '/admin/box-office',
  door: '/admin/door',
  cashUp: '/admin/cash-up',
  scanners: '/admin/scanners',
  banking: '/admin/banking',
  accounting: '/admin/accounting',
  design: '/admin/design',
  settings: '/admin/settings',
  administration: '/admin/administration',
  // Pages reached through a hub (not in the sidebar themselves).
  ticketTemplates: '/admin/ticket-templates',
  emailTemplates: '/admin/email-templates',
  media: '/admin/media',
  symbols: '/admin/symbols',
  fees: '/admin/settings/fees',
  waitingRoom: '/admin/settings/waitingRoom',
  users: '/admin/users',
  backups: '/admin/backups',
  system: '/admin/system',
  audit: '/admin/audit',
} as const;

export type NavKey = keyof typeof NAV_HREFS;

export type SidebarHeading = 'events' | 'sales' | 'onSite' | 'finance';

/** Sidebar sections in display order (`heading: null` = no title; `separator` = rule above). */
export const SIDEBAR_GROUPS: readonly {
  heading: SidebarHeading | null;
  separator?: boolean;
  keys: readonly NavKey[];
}[] = [
  { heading: null, keys: ['dashboard'] },
  { heading: 'events', keys: ['events', 'venues'] },
  { heading: 'sales', keys: ['orders', 'customers', 'discounts', 'refunds', 'statistics'] },
  { heading: 'onSite', keys: ['boxOffice', 'door', 'cashUp', 'scanners'] },
  { heading: 'finance', keys: ['banking', 'accounting'] },
  { heading: null, separator: true, keys: ['design', 'settings', 'administration'] },
];

export type HubKey = 'design' | 'settings' | 'administration';

/**
 * Pages a hub bundles. A hub is shown when the user may open it or any of these pages; its badge
 * is the sum of their badges. Settings pages inside the design / system hubs belong to `settings`.
 */
export const HUB_CHILDREN: Record<HubKey, readonly NavKey[]> = {
  design: ['ticketTemplates', 'emailTemplates', 'media', 'symbols'],
  settings: ['fees', 'waitingRoom'],
  administration: ['users', 'backups', 'system', 'audit'],
};

/** URL prefixes that highlight a sidebar entry (default: its own URL). */
const ACTIVE_PREFIXES: Partial<Record<NavKey, readonly string[]>> = {
  venues: ['/admin/venues', '/admin/seat-maps'],
  design: [
    '/admin/design',
    '/admin/ticket-templates',
    '/admin/email-templates',
    '/admin/media',
    '/admin/symbols',
  ],
  settings: ['/admin/settings'],
  administration: [
    '/admin/administration',
    '/admin/users',
    '/admin/backups',
    '/admin/system',
    '/admin/audit',
  ],
};

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The sidebar entry to highlight for a pathname (without locale prefix), or null. */
export function activeSidebarKey(pathname: string): NavKey | null {
  if (pathname === NAV_HREFS.dashboard) return 'dashboard';
  for (const group of SIDEBAR_GROUPS) {
    for (const key of group.keys) {
      if (key === 'dashboard') continue;
      const prefixes = ACTIVE_PREFIXES[key] ?? [NAV_HREFS[key]];
      if (prefixes.some((p) => under(pathname, p))) return key;
    }
  }
  return null;
}

export interface SidebarItem {
  key: NavKey;
  /** Target URL (a hub the user may not open itself leads to its first allowed page). */
  href: string;
  badge: number;
}

export interface SidebarSection {
  heading: SidebarHeading | null;
  separator: boolean;
  items: SidebarItem[];
}

/** Sidebar sections for the allowed keys (empty sections dropped, hubs resolved). */
export function buildSidebar(
  allowed: readonly NavKey[],
  badges: Partial<Record<NavKey, number>> = {},
): SidebarSection[] {
  const isHub = (key: NavKey): key is HubKey => key in HUB_CHILDREN;
  return SIDEBAR_GROUPS.map((group) => ({
    heading: group.heading,
    separator: group.separator ?? false,
    items: group.keys.flatMap((key): SidebarItem[] => {
      if (!isHub(key)) {
        return allowed.includes(key)
          ? [{ key, href: NAV_HREFS[key], badge: badges[key] ?? 0 }]
          : [];
      }
      const children = HUB_CHILDREN[key].filter((k) => allowed.includes(k));
      const self = allowed.includes(key);
      if (!self && children.length === 0) return [];
      const href = self ? NAV_HREFS[key] : NAV_HREFS[children[0]!];
      const badge = [key, ...children].reduce((sum, k) => sum + (badges[k] ?? 0), 0);
      return [{ key, href, badge }];
    }),
  })).filter((s) => s.items.length > 0);
}
