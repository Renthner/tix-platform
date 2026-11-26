'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useGuardedNavigation } from '@/components/admin/unsaved-changes';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/** Scroll position of the menu, restored when the next event page mounts it again. */
const SCROLL_KEY = 'tix-event-menu-scroll';

type EventMenuItem =
  | 'overview'
  | 'details'
  | 'seating'
  | 'pricing'
  | 'fees'
  | 'sales'
  | 'accessCodes'
  | 'waitingRoom'
  | 'page'
  | 'ticket'
  | 'wallet'
  | 'communication'
  | 'checkIn'
  | 'status';

/** Menu of an event: groups are always expanded (about 15 entries fit one screen). */
const EVENT_MENU: {
  group: 'setup' | 'sales' | 'presentation' | 'operations' | null;
  items: { segment: string; key: EventMenuItem }[];
}[] = [
  { group: null, items: [{ segment: '', key: 'overview' }] },
  {
    group: 'setup',
    items: [
      { segment: '/details', key: 'details' },
      { segment: '/seating', key: 'seating' },
      { segment: '/pricing', key: 'pricing' },
      { segment: '/fees', key: 'fees' },
    ],
  },
  {
    group: 'sales',
    items: [
      { segment: '/sales', key: 'sales' },
      { segment: '/access-codes', key: 'accessCodes' },
      { segment: '/waiting-room', key: 'waitingRoom' },
    ],
  },
  {
    group: 'presentation',
    items: [
      { segment: '/shop-page', key: 'page' },
      { segment: '/ticket', key: 'ticket' },
      { segment: '/wallet', key: 'wallet' },
    ],
  },
  {
    group: 'operations',
    items: [
      { segment: '/communication', key: 'communication' },
      { segment: '/check-in', key: 'checkIn' },
      { segment: '/status', key: 'status' },
    ],
  },
];

const EVENT_MENU_SEGMENTS = EVENT_MENU.flatMap((g) => g.items.map((i) => i.segment));

/**
 * Event menu: on md+ its own scroll pane next to the content (position kept across event pages);
 * on small screens a native select. The overview is active only on its exact URL, every other
 * entry also on its sub-pages.
 */
export function EventNav({ eventId }: { eventId: string }) {
  const t = useTranslations('admin.events');
  const pathname = usePathname();
  const router = useRouter();
  const guarded = useGuardedNavigation();
  const navRef = useRef<HTMLElement>(null);
  const base = `/admin/events/${eventId}`;
  const isActive = (segment: string) => {
    const href = `${base}${segment}`;
    return segment === ''
      ? pathname === base
      : pathname === href || pathname.startsWith(`${href}/`);
  };
  const current = EVENT_MENU_SEGMENTS.find(isActive);

  // Restore the menu's scroll position (the menu remounts on every event page).
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

  // Remember the scroll position (once per frame).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
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
  }, []);

  const headingClass =
    'px-3 pb-1 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase';

  return (
    <>
      <label className="flex flex-col gap-1.5 text-sm font-medium md:hidden">
        {t('menu.pageSelect')}
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={current ?? ''}
          onChange={(e) => {
            const href = `${base}${e.target.value}`;
            guarded(() => router.push(href));
          }}
        >
          {EVENT_MENU.map(({ group, items }) => {
            const options = items.map(({ segment, key }) => (
              <option key={key} value={segment}>
                {t(`tabs.${key}`)}
              </option>
            ));
            return group ? (
              <optgroup key={group} label={t(`menu.groups.${group}`)}>
                {options}
              </optgroup>
            ) : (
              options
            );
          })}
        </select>
      </label>
      {/* md+ only: the menu pane, scrolling on its own below the fixed page header (the window
          does not scroll there). Padding keeps the focus rings inside. */}
      <nav
        ref={navRef}
        data-testid="event-menu-pane"
        className="hidden w-56 shrink-0 flex-col gap-4 overscroll-contain md:relative md:flex md:min-h-0 md:overflow-y-auto md:py-6 md:pr-2 md:pl-6"
        aria-label={t('menu.label')}
      >
        {EVENT_MENU.map(({ group, items }) => {
          const headingId = group ? `event-menu-${group}` : undefined;
          return (
            <div key={group ?? 'top'} className="flex flex-col gap-0.5">
              {group && (
                <h2 id={headingId} className={cn(headingClass, 'py-1')}>
                  {t(`menu.groups.${group}`)}
                </h2>
              )}
              <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                {items.map(({ segment, key }) => {
                  const active = isActive(segment);
                  return (
                    <li key={key}>
                      <Link
                        href={`${base}${segment}`}
                        scroll={false}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'block rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                          active
                            ? 'bg-accent font-medium'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {t(`tabs.${key}`)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </>
  );
}

/**
 * Content pane of an event page (md+: scrolls on its own). Keyed by the path, so a new event page
 * starts at the top while query changes (filters, paging) keep the position.
 */
export function EventContentPane({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div
      key={pathname}
      data-testid="event-content-pane"
      // `relative`: absolutely positioned helpers (hidden checkbox/switch inputs, sr-only text)
      // must be contained by the scrolling pane, otherwise they stretch the document.
      className="min-w-0 md:relative md:min-h-0 md:flex-1 md:overflow-y-auto md:py-6 md:pr-6 md:pl-4"
    >
      {children}
    </div>
  );
}
