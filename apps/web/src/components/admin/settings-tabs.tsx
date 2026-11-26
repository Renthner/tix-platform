'use client';

import { ChevronDown } from 'lucide-react';
import { SETTINGS_GROUP_ICONS } from '@/components/admin/settings-group-icons';
import { useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useGuardedNavigation } from '@/components/admin/unsaved-changes';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import {
  SETTINGS_GROUPS_COOKIE,
  SETTINGS_GROUPS_COOKIE_MAX_AGE_SECONDS,
  parseOpenSettingsGroups,
  type SettingsGroup,
  type SettingsGroupKey,
  type SettingsTab,
} from '@/lib/settings-tabs';
import { cn } from '@/lib/utils';

/** Scroll position of the menu, restored when the next settings page mounts it again. */
const SCROLL_KEY = 'tix-settings-menu-scroll';

/**
 * Expanded groups as last saved in this page load. A client navigation may render a page from
 * the router cache with an older `initialOpen`; this keeps the newest state. Null on a fresh load
 * (hydration then uses the server value read from the same cookie).
 */
let lastOpen: SettingsGroupKey[] | null = null;

function readOpenCookie(): SettingsGroupKey[] {
  const prefix = `${SETTINGS_GROUPS_COOKIE}=`;
  const entry = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return parseOpenSettingsGroups(entry?.slice(prefix.length));
}

function GroupIcon({ group }: { group: SettingsGroupKey }) {
  const Icon = SETTINGS_GROUP_ICONS[group];
  return <Icon className="size-3.5 shrink-0" aria-hidden />;
}

function withGroup(open: SettingsGroupKey[], group: SettingsGroupKey | undefined) {
  return group && !open.includes(group) ? [...open, group] : open;
}

function writeOpenCookie(open: readonly SettingsGroupKey[]) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${SETTINGS_GROUPS_COOKIE}=${encodeURIComponent(open.join(','))}; Max-Age=${SETTINGS_GROUPS_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

/**
 * Settings menu of a settings page: on md+ a search over page names and field labels (`index`:
 * texts per page) above collapsible groups; on small screens a native select. `groups` and
 * `index` contain only the pages the user may open. A group is open iff it is in the saved set
 * (cookie, `initialOpen` read by the server); visiting a page adds its group to that set. Every
 * group, the current one too, can be collapsed. On md+ the menu is its own scroll pane whose
 * position survives page changes.
 */
export function SettingsTabs({
  groups,
  index,
  initialOpen,
}: {
  groups: SettingsGroup[];
  index: Record<string, string[]>;
  initialOpen: SettingsGroupKey[];
}) {
  const t = useTranslations('admin.settings.tabs');
  const pathname = usePathname();
  const router = useRouter();
  const guarded = useGuardedNavigation();
  const [query, setQuery] = useState('');
  const navRef = useRef<HTMLElement>(null);
  const isActive = (tab: SettingsTab) => {
    const href = `/admin/settings/${tab}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  };
  const current = groups.flatMap((g) => g.tabs).find(isActive);
  const activeGroup = groups.find((g) => current && g.tabs.includes(current))?.group;
  // The visited page's group is open from the first paint (a no-op on a fresh load: the server
  // already added it). Computed here so the scroll restore below sees the final menu height.
  const [open, setOpen] = useState<SettingsGroupKey[]>(() =>
    withGroup(lastOpen ?? initialOpen, activeGroup),
  );

  // Visiting a page saves its group as open. Runs only when the page changes, so a collapsed
  // current group stays collapsed until the next navigation.
  useEffect(() => {
    if (!activeGroup) return;
    const saved = lastOpen ?? readOpenCookie();
    const next = withGroup(saved, activeGroup);
    lastOpen = next;
    if (next !== saved) writeOpenCookie(next);
    setOpen((prev) => withGroup(prev, activeGroup));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on navigation (see above)
  }, [pathname]);

  const toggle = (group: SettingsGroupKey) => {
    const next = open.includes(group) ? open.filter((g) => g !== group) : [...open, group];
    lastOpen = next;
    setOpen(next);
    writeOpenCookie(next);
  };

  const needle = query.trim().toLowerCase();
  const searching = needle !== '';

  // Restore the menu's scroll position (the menu remounts on every settings page).
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    try {
      const saved = Number(window.sessionStorage.getItem(SCROLL_KEY));
      if (Number.isFinite(saved) && saved > 0) nav.scrollTop = saved;
    } catch {
      // Storage unavailable (privacy mode): start at the top.
    }
  }, []);

  // Remember the scroll position (once per frame); not while the search results are shown.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || searching) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        try {
          window.sessionStorage.setItem(SCROLL_KEY, String(Math.round(nav.scrollTop)));
        } catch {
          // Storage unavailable: nothing to remember.
        }
      });
    };
    nav.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      nav.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [searching]);

  const results = searching
    ? groups.flatMap(({ group, tabs }) =>
        tabs.flatMap((tab) => {
          const label = t(tab);
          const hits = (index[tab] ?? []).filter((text) => text.toLowerCase().includes(needle));
          const nameHit =
            label.toLowerCase().includes(needle) ||
            t(`groups.${group}`).toLowerCase().includes(needle);
          return nameHit || hits.length > 0
            ? [{ tab, label, group, hits: nameHit ? [] : hits.slice(0, 2) }]
            : [];
        }),
      )
    : null;

  const linkClass = (tab: SettingsTab) =>
    cn(
      'block rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent',
      isActive(tab) ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground',
    );
  const headingClass =
    'px-3 pb-1 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase';

  return (
    <>
      <label className="flex flex-col gap-1.5 text-sm font-medium md:hidden">
        {t('pageSelect')}
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={current ?? ''}
          onChange={(e) => {
            const href = `/admin/settings/${e.target.value}`;
            guarded(() => router.push(href));
          }}
        >
          {groups.map(({ group, tabs }) => (
            <optgroup key={group} label={t(`groups.${group}`)}>
              {tabs.map((tab) => (
                <option key={tab} value={tab}>
                  {t(tab)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {/* md+ only: the menu pane of the settings page, scrolling on its own below the fixed page
          header (the window does not scroll there). Padding keeps the focus rings inside. */}
      <nav
        ref={navRef}
        data-testid="settings-menu-pane"
        className="hidden w-64 shrink-0 flex-col gap-4 overscroll-contain md:relative md:flex md:min-h-0 md:overflow-y-auto md:py-6 md:pr-2 md:pl-6"
        aria-label={t('label')}
      >
        <div className="sticky top-0 z-10 -m-1 bg-background p-1">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel')}
          />
        </div>
        {results ? (
          <ul className="flex flex-col gap-0.5">
            {results.map(({ tab, label, group, hits }) => (
              <li key={tab}>
                <Link
                  href={`/admin/settings/${tab}`}
                  scroll={false}
                  aria-current={isActive(tab) ? 'page' : undefined}
                  className={linkClass(tab)}
                >
                  <span className="block">{label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`groups.${group}`)}
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
          groups.map(({ group, tabs }) => {
            const headingId = `settings-menu-${group}`;
            const listId = `settings-menu-${group}-pages`;
            const expanded = open.includes(group);
            return (
              <div key={group} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  id={headingId}
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => toggle(group)}
                  className={cn(
                    headingClass,
                    'flex items-center gap-1.5 rounded-md py-1 text-left transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  )}
                >
                  <GroupIcon group={group} />
                  <span className="min-w-0 flex-1">{t(`groups.${group}`)}</span>
                  {!expanded && (
                    <span className="font-normal tracking-normal tabular-nums opacity-70">
                      {tabs.length}
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      'size-3.5 shrink-0 transition-transform',
                      expanded && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </button>
                <ul
                  id={listId}
                  aria-labelledby={headingId}
                  hidden={!expanded}
                  className={cn('flex-col gap-0.5', expanded ? 'flex' : 'hidden')}
                >
                  {tabs.map((tab) => (
                    <li key={tab}>
                      <Link
                        href={`/admin/settings/${tab}`}
                        scroll={false}
                        aria-current={isActive(tab) ? 'page' : undefined}
                        className={linkClass(tab)}
                      >
                        {t(tab)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </nav>
    </>
  );
}
