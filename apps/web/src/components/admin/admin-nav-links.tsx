'use client';

import {
  Building2,
  Calculator,
  DatabaseBackup,
  CalendarDays,
  Hourglass,
  Images,
  Landmark,
  Mail,
  LayoutDashboard,
  ChartLine,
  Activity,
  ScanLine,
  Percent,
  ReceiptText,
  Settings,
  Shapes,
  Store,
  Ticket,
  Undo2,
  Menu,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export const NAV_ITEMS = {
  dashboard: { href: '/admin', icon: LayoutDashboard, exact: true },
  boxOffice: { href: '/admin/box-office', icon: Store, exact: false },
  events: { href: '/admin/events', icon: CalendarDays, exact: false },
  orders: { href: '/admin/orders', icon: ReceiptText, exact: false },
  statistics: { href: '/admin/statistics', icon: ChartLine, exact: false },
  customers: { href: '/admin/customers', icon: UserRound, exact: false },
  banking: { href: '/admin/banking', icon: Landmark, exact: false },
  refunds: { href: '/admin/refunds', icon: Undo2, exact: false },
  accounting: { href: '/admin/accounting', icon: Calculator, exact: false },
  fees: { href: '/admin/fees', icon: Percent, exact: false },
  emailTemplates: { href: '/admin/email-templates', icon: Mail, exact: false },
  ticketTemplates: { href: '/admin/ticket-templates', icon: Ticket, exact: false },
  venues: { href: '/admin/venues', icon: Building2, exact: false },
  media: { href: '/admin/media', icon: Images, exact: false },
  symbols: { href: '/admin/symbols', icon: Shapes, exact: false },
  waitingRoom: { href: '/admin/waiting-room', icon: Hourglass, exact: false },
  users: { href: '/admin/users', icon: Users, exact: false },
  scanners: { href: '/admin/scanners', icon: ScanLine, exact: false },
  backups: { href: '/admin/backups', icon: DatabaseBackup, exact: false },
  system: { href: '/admin/system', icon: Activity, exact: false },
  settings: { href: '/admin/settings', icon: Settings, exact: false },
} satisfies Record<string, { href: string; icon: LucideIcon; exact: boolean }>;

export type NavKey = keyof typeof NAV_ITEMS;

/** Renders the admin navigation entries the current user may access (filtered on the server). */
export function AdminNavLinks({
  keys,
  badges = {},
}: {
  keys: NavKey[];
  badges?: Partial<Record<NavKey, number>>;
}) {
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
            {(badges[key] ?? 0) > 0 && (
              <span className="ml-auto rounded-full bg-destructive-solid px-1.5 text-xs font-medium text-destructive-foreground">
                {badges[key]}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Compact navigation for small screens (the sidebar is hidden below the md breakpoint). */
export function AdminMobileMenu({
  keys,
  badges = {},
  children,
}: {
  keys: NavKey[];
  badges?: Partial<Record<NavKey, number>>;
  /** Extra entries (server-rendered), e.g. the sign-out form. */
  children?: ReactNode;
}) {
  const t = useTranslations('admin.nav');
  const pathname = usePathname();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t('menu')}>
          <Menu className="size-4" /> <span>{t('menu')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} className="min-w-56">
        {keys.map((key) => {
          const { href, icon: Icon, exact } = NAV_ITEMS[key];
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <DropdownMenuItem key={key} asChild>
              <Link href={href} className={cn(active && 'font-medium')}>
                <Icon className="size-4" />
                {t(key)}
                {(badges[key] ?? 0) > 0 && (
                  <span className="ml-auto rounded-full bg-destructive-solid px-1.5 text-xs font-medium text-destructive-foreground">
                    {badges[key]}
                  </span>
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
