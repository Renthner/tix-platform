'use client';

import {
  Building2,
  ChevronRight,
  Calculator,
  ClipboardCheck,
  Coins,
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
  ScrollText,
  Percent,
  TicketPercent,
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
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/** PayPal logo mark (Simple Icons, CC0); lucide ships no brand icons. */
const PayPalIcon = (({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z" />
  </svg>
)) as unknown as LucideIcon;

export const NAV_ITEMS = {
  dashboard: { href: '/admin', icon: LayoutDashboard, exact: true },
  boxOffice: { href: '/admin/box-office', icon: Store, exact: false },
  cashUp: { href: '/admin/cash-up', icon: Coins, exact: false },
  door: { href: '/admin/door', icon: ClipboardCheck, exact: false },
  events: { href: '/admin/events', icon: CalendarDays, exact: false },
  orders: { href: '/admin/orders', icon: ReceiptText, exact: false },
  statistics: { href: '/admin/statistics', icon: ChartLine, exact: false },
  customers: { href: '/admin/customers', icon: UserRound, exact: false },
  banking: { href: '/admin/banking', icon: Landmark, exact: false },
  paypal: { href: '/admin/settings/paypal', icon: PayPalIcon, exact: false },
  refunds: { href: '/admin/refunds', icon: Undo2, exact: false },
  accounting: { href: '/admin/accounting', icon: Calculator, exact: false },
  fees: { href: '/admin/fees', icon: Percent, exact: false },
  discounts: { href: '/admin/discounts', icon: TicketPercent, exact: false },
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
  audit: { href: '/admin/audit', icon: ScrollText, exact: false },
  settings: { href: '/admin/settings', icon: Settings, exact: false },
} satisfies Record<string, { href: string; icon: LucideIcon; exact: boolean }>;

export type NavKey = keyof typeof NAV_ITEMS;

/**
 * Sidebar sections (display order). `heading: null` = entries without a section title at the top.
 * Every NavKey must appear exactly once; sections without an accessible entry are hidden.
 */
export const NAV_GROUPS: readonly {
  heading: 'sales' | 'events' | 'design' | 'finance' | 'administration' | null;
  keys: readonly NavKey[];
}[] = [
  { heading: null, keys: ['dashboard', 'boxOffice', 'door'] },
  {
    heading: 'sales',
    keys: ['orders', 'cashUp', 'customers', 'discounts', 'refunds', 'statistics'],
  },
  { heading: 'events', keys: ['events', 'venues', 'waitingRoom', 'scanners'] },
  { heading: 'design', keys: ['ticketTemplates', 'emailTemplates', 'media', 'symbols'] },
  { heading: 'finance', keys: ['banking', 'paypal', 'accounting', 'fees'] },
  { heading: 'administration', keys: ['users', 'backups', 'system', 'audit', 'settings'] },
];

/** Splits the accessible keys into the configured sections (empty sections dropped). */
function groupKeys(keys: readonly NavKey[]) {
  return NAV_GROUPS.map((g) => ({
    heading: g.heading,
    keys: g.keys.filter((k) => keys.includes(k)),
  })).filter((g) => g.keys.length > 0);
}

type Badges = Partial<Record<NavKey, number>>;

function groupBadge(keys: readonly NavKey[], badges: Badges) {
  return keys.reduce((sum, k) => sum + (badges[k] ?? 0), 0);
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto rounded-full bg-destructive-solid px-1.5 text-xs font-medium text-destructive-foreground">
      {count}
    </span>
  );
}

/**
 * Renders the admin navigation entries the current user may access (filtered on the server).
 * Sections are collapsed by default; the one containing the current page is open.
 */
export function AdminNavLinks({ keys, badges = {} }: { keys: NavKey[]; badges?: Badges }) {
  const t = useTranslations('admin.nav');
  const pathname = usePathname();
  const isActive = (key: NavKey) => {
    const { href, exact } = NAV_ITEMS[key];
    if (key === 'settings' && pathname.startsWith(NAV_ITEMS.paypal.href)) return false;
    return exact ? pathname === href : pathname.startsWith(href);
  };
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const link = (key: NavKey, indent = false) => {
    const { href, icon: Icon } = NAV_ITEMS[key];
    const active = isActive(key);
    return (
      <Link
        key={key}
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent',
          indent && 'ml-3',
          active && 'bg-accent font-medium',
        )}
      >
        <Icon className="size-4" aria-hidden />
        {t(key)}
        <Badge count={badges[key] ?? 0} />
      </Link>
    );
  };

  return (
    <nav aria-label={t('label')} className="flex flex-col gap-1">
      {groupKeys(keys).map((group) => {
        if (!group.heading) return group.keys.map((key) => link(key));
        const id = group.heading;
        const open = toggled[id] ?? group.keys.some(isActive);
        const hiddenBadge = open ? 0 : groupBadge(group.keys, badges);
        return (
          <div key={id} className="flex flex-col gap-1">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setToggled((prev) => ({ ...prev, [id]: !open }))}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
              <span className="text-left">{t(`groups.${id}`)}</span>
              <Badge count={hiddenBadge} />
            </button>
            {open && group.keys.map((key) => link(key, true))}
          </div>
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
  badges?: Badges;
  /** Extra entries (server-rendered), e.g. the sign-out form. */
  children?: ReactNode;
}) {
  const t = useTranslations('admin.nav');
  const pathname = usePathname();
  const item = (key: NavKey) => {
    const { href, icon: Icon, exact } = NAV_ITEMS[key];
    const active =
      key === 'settings' && pathname.startsWith(NAV_ITEMS.paypal.href)
        ? false
        : exact
          ? pathname === href
          : pathname.startsWith(href);
    return (
      <DropdownMenuItem key={key} asChild>
        <Link
          href={href}
          aria-current={active ? 'page' : undefined}
          className={cn(active && 'font-medium')}
        >
          <Icon className="size-4" />
          {t(key)}
          <Badge count={badges[key] ?? 0} />
        </Link>
      </DropdownMenuItem>
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t('menu')}>
          <Menu className="size-4" /> <span>{t('menu')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} className="min-w-56">
        {groupKeys(keys).map((group) =>
          group.heading ? (
            <DropdownMenuSub key={group.heading}>
              <DropdownMenuSubTrigger>
                {t(`groups.${group.heading}`)}
                <Badge count={groupBadge(group.keys, badges)} />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>{group.keys.map(item)}</DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            group.keys.map(item)
          ),
        )}
        {children && <DropdownMenuSeparator />}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
