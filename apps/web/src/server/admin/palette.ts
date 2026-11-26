import type { AdminRole } from '@tix/shared';
import { getTranslations } from 'next-intl/server';
import { HUB_CHILDREN, NAV_HREFS, SIDEBAR_GROUPS, type NavKey } from '@/lib/admin-nav-model';
import { allowedSettingsTabs, SETTINGS_TAB_GROUPS } from '@/lib/settings-tabs';
import { buildSettingsSearchIndex } from '@/server/admin/settings-search';

/** A static entry of the admin search palette (page, hub or settings page). */
export interface PaletteEntry {
  id: string;
  label: string;
  /** Section shown next to the label ("Sales", "Design", "Settings · E-mail" …). */
  group: string;
  href: string;
  /** Extra searchable texts (field labels of a settings page). */
  keywords: string[];
}

/**
 * Static palette entries for the pages the user may open (`keys` = allowed navigation keys,
 * `roles` decide the settings pages): every admin page and hub, plus every settings page the user
 * may open with its field labels (the label index is only built for those pages).
 */
export async function buildPaletteEntries(
  keys: readonly NavKey[],
  roles: readonly AdminRole[],
): Promise<PaletteEntry[]> {
  const [t, ts] = await Promise.all([
    getTranslations('admin.nav'),
    getTranslations('admin.settings'),
  ]);
  const groupOf = new Map<NavKey, string>();
  for (const group of SIDEBAR_GROUPS) {
    for (const key of group.keys) {
      groupOf.set(key, group.heading ? t(`groups.${group.heading}`) : t('pages'));
    }
  }
  for (const [hub, children] of Object.entries(HUB_CHILDREN) as [NavKey, readonly NavKey[]][]) {
    for (const key of children) groupOf.set(key, t(hub));
  }
  const tabs = allowedSettingsTabs(roles);
  // Fees and waiting room are settings pages: listed below with their field labels.
  const asSettings = new Set<string>(tabs);
  const pages = keys.filter((key) => !asSettings.has(key));
  const entries: PaletteEntry[] = pages.map((key) => ({
    id: `page:${key}`,
    label: key === 'dashboard' ? t('overview') : t(key),
    group: groupOf.get(key) ?? t('pages'),
    href: NAV_HREFS[key],
    keywords: [],
  }));
  entries.push({
    id: 'page:account',
    label: t('account'),
    group: t('pages'),
    href: '/admin/account',
    keywords: [],
  });
  if (tabs.length > 0) {
    const index = await buildSettingsSearchIndex(tabs);
    const allowed = new Set<string>(tabs);
    for (const { group, tabs: groupTabs } of SETTINGS_TAB_GROUPS) {
      for (const tab of groupTabs) {
        if (!allowed.has(tab)) continue;
        entries.push({
          id: `settings:${tab}`,
          label: ts(`tabs.${tab}`),
          group: `${t('settings')} · ${ts(`tabs.groups.${group}`)}`,
          href: `/admin/settings/${tab}`,
          keywords: index[tab] ?? [],
        });
      }
    }
  }
  return entries;
}
