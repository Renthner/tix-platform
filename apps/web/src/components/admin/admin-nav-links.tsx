'use client';

import {
  Building2,
  CalendarDays,
  Hourglass,
  LayoutDashboard,
  Settings,
  Shapes,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export const NAV_ITEMS = {
  dashboard: { href: '/admin', icon: LayoutDashboard, exact: true },
  events: { href: '/admin/events', icon: CalendarDays, exact: false },
  venues: { href: '/admin/venues', icon: Building2, exact: false },
  symbols: { href: '/admin/symbols', icon: Shapes, exact: false },
  waitingRoom: { href: '/admin/waiting-room', icon: Hourglass, exact: false },
  settings: { href: '/admin/settings', icon: Settings, exact: false },
} satisfies Record<string, { href: string; icon: LucideIcon; exact: boolean }>;

export type NavKey = keyof typeof NAV_ITEMS;

/** Renders the admin navigation entries the current user may access (filtered on the server). */
export function AdminNavLinks({ keys }: { keys: NavKey[] }) {
  const t = useTranslations('admin.nav');
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {keys.map((key) => {
        const { href, icon: Icon, exact } = NAV_ITEMS[key];
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={key}
            href={href}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent',
              active && 'bg-accent font-medium',
            )}
          >
            <Icon className="size-4" />
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}
