'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Link, usePathname } from '@/i18n/navigation';
import { SETTINGS_TAB_GROUPS, type SettingsTab } from '@/lib/settings-tabs';
import { cn } from '@/lib/utils';

type GroupKey = (typeof SETTINGS_TAB_GROUPS)[number]['group'];

const GROUP_OF = Object.fromEntries(
  SETTINGS_TAB_GROUPS.flatMap((g) => g.tabs.map((tab) => [tab, g.group] as const)),
) as Partial<Record<SettingsTab, GroupKey>>;

/**
 * Settings side menu: collapsible groups (the one with the current page is open), one topic per
 * page, plus a search over page names and field labels (`index`: texts per page).
 * Horizontal scroll on small screens.
 */
export function SettingsTabs({ index }: { index: Record<string, string[]> }) {
  const t = useTranslations('admin.settings.tabs');
  const pathname = usePathname();
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const isActive = (tab: string) => {
    const href = `/admin/settings/${tab}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const needle = query.trim().toLowerCase();
  const results = needle
    ? (Object.keys(index) as SettingsTab[]).flatMap((tab) => {
        const label = t(tab);
        const group = GROUP_OF[tab];
        const hits = (index[tab] ?? []).filter((text) => text.toLowerCase().includes(needle));
        const nameHit =
          label.toLowerCase().includes(needle) ||
          (group ? t(`groups.${group}`).toLowerCase().includes(needle) : false);
        return nameHit || hits.length > 0
          ? [{ tab, label, group, hits: nameHit ? [] : hits.slice(0, 2) }]
          : [];
      })
    : null;

  const linkClass = (tab: string) =>
    cn(
      'block rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent',
      isActive(tab) ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground',
    );

  return (
    <nav className="flex shrink-0 flex-col gap-3 md:w-56" aria-label={t('label')}>
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchLabel')}
      />
      {results ? (
        <ul className="flex flex-col gap-0.5">
          {results.map(({ tab, label, group, hits }) => (
            <li key={tab}>
              <Link
                href={`/admin/settings/${tab}`}
                aria-current={isActive(tab) ? 'page' : undefined}
                className={linkClass(tab)}
              >
                <span className="block">{label}</span>
                <span className="block text-xs text-muted-foreground">
                  {group ? t(`groups.${group}`) : t('groups.payment')}
                  {hits.length > 0 && ` · ${hits.join(' · ')}`}
                </span>
              </Link>
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-3 py-1.5 text-sm text-muted-foreground">{t('searchNone')}</li>
          )}
        </ul>
      ) : (
        <div className="flex gap-4 overflow-x-auto md:flex-col md:gap-1 md:overflow-visible">
          {SETTINGS_TAB_GROUPS.map((group) => {
            const open = toggled[group.group] ?? group.tabs.some(isActive);
            return (
              <div key={group.group} className="flex shrink-0 flex-col gap-0.5">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setToggled((prev) => ({ ...prev, [group.group]: !open }))}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors hover:bg-accent"
                >
                  <ChevronRight
                    className={cn('size-4 transition-transform', open && 'rotate-90')}
                  />
                  <span className="text-left">{t(`groups.${group.group}`)}</span>
                </button>
                {open &&
                  group.tabs.map((tab) => (
                    <Link
                      key={tab}
                      href={`/admin/settings/${tab}`}
                      aria-current={isActive(tab) ? 'page' : undefined}
                      className={cn(linkClass(tab), 'ml-4')}
                    >
                      {t(tab)}
                    </Link>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}
