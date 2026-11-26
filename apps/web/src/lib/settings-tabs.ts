import type { AdminRole } from '@tix/shared';

/**
 * Pages of the admin settings (URL based: reloads and shared links keep the page).
 * One page = one topic (usually one card), grouped in the settings menu and on the overview.
 * Keys `appearance` (branding), `payments` (bank transfer), `email` (SMTP), `wallet` (intro + design)
 * and `accounts` (customer accounts) keep their historical URLs.
 *
 * Kept free of runtime imports: the unit test runs this file directly with Node.
 */
export const SETTINGS_TAB_GROUPS = [
  { group: 'shop', tabs: ['general', 'organizer', 'seo', 'cookies'] },
  { group: 'design', tabs: ['appearance', 'startPage', 'shopLayout', 'sponsors', 'seatDisplay'] },
  {
    group: 'sales',
    tabs: ['checkout', 'fees', 'waitingRoom', 'waitlist', 'accounts', 'selfService'],
  },
  { group: 'payment', tabs: ['payments', 'paypal', 'invoicing'] },
  { group: 'communication', tabs: ['email', 'emailHeader', 'notifications'] },
  { group: 'tickets', tabs: ['wallet', 'walletApple', 'walletGoogle', 'scanner'] },
  { group: 'system', tabs: ['security', 'privacy', 'monitoring'] },
] as const;

export type SettingsGroupKey = (typeof SETTINGS_TAB_GROUPS)[number]['group'];

/** Valid pages, in menu order. */
export const SETTINGS_TABS = SETTINGS_TAB_GROUPS.flatMap((g) => g.tabs);
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function isSettingsTab(value: string): value is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(value);
}

/**
 * Roles that may open a settings page (single source of truth for the page gate, the menu, the
 * overview and the search palette). Default: super admins only. SUPER_ADMIN may open every page.
 */
const TAB_ROLE_EXCEPTIONS: Partial<Record<SettingsTab, readonly AdminRole[]>> = {
  fees: ['FINANCE', 'EVENT_MANAGER'],
  waitingRoom: ['EVENT_MANAGER'],
};
export const SETTINGS_TAB_ROLES = Object.fromEntries(
  SETTINGS_TABS.map((tab) => [tab, TAB_ROLE_EXCEPTIONS[tab] ?? ['SUPER_ADMIN']]),
) as Record<SettingsTab, readonly AdminRole[]>;

/** Union of all roles that may open at least one settings page (gate of the overview). */
export const SETTINGS_ROLES: readonly AdminRole[] = [
  ...new Set(Object.values(SETTINGS_TAB_ROLES).flat()),
];

/** Settings pages these roles may open, in menu order (same rule as `hasRole`). */
export function allowedSettingsTabs(roles: readonly AdminRole[]): SettingsTab[] {
  const isSuper = roles.includes('SUPER_ADMIN');
  return SETTINGS_TABS.filter(
    (tab) => isSuper || SETTINGS_TAB_ROLES[tab].some((r) => roles.includes(r)),
  );
}

/**
 * Cookie remembering (per browser) which settings menu groups are expanded: comma-separated list
 * of group keys (URI-encoded). Written by the client menu, read by the settings page.
 */
export const SETTINGS_GROUPS_COOKIE = 'tix_admin_settings_groups';
/** Expanded groups are remembered for one year. */
export const SETTINGS_GROUPS_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 3600;

/** Open groups from the cookie value: known keys only, no duplicates, junk ignored. */
export function parseOpenSettingsGroups(raw: string | undefined | null): SettingsGroupKey[] {
  if (!raw) return [];
  let value = raw;
  try {
    // Idempotent for the plain keys: copes with a still encoded (`%2C`) value.
    value = decodeURIComponent(raw);
  } catch {
    // Malformed escape: parse as is.
  }
  const known = new Set<string>(SETTINGS_TAB_GROUPS.map((g) => g.group));
  const open = new Set<SettingsGroupKey>();
  for (const part of value.split(',')) {
    const key = part.trim();
    if (known.has(key)) open.add(key as SettingsGroupKey);
  }
  return [...open];
}

export interface SettingsGroup {
  group: SettingsGroupKey;
  tabs: SettingsTab[];
}

/** Menu groups with the pages these roles may open (empty groups dropped). */
export function settingsGroupsFor(roles: readonly AdminRole[]): SettingsGroup[] {
  const allowed = new Set(allowedSettingsTabs(roles));
  return SETTINGS_TAB_GROUPS.map((g) => ({
    group: g.group,
    tabs: g.tabs.filter((tab) => allowed.has(tab)),
  })).filter((g) => g.tabs.length > 0);
}
