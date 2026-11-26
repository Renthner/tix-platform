'use client';

import {
  Activity,
  Building2,
  Calculator,
  CalendarDays,
  ChartLine,
  ClipboardCheck,
  Coins,
  DatabaseBackup,
  Hourglass,
  Images,
  Landmark,
  LayoutDashboard,
  Mail,
  Menu,
  Palette,
  Percent,
  ReceiptText,
  ScanLine,
  ScrollText,
  Server,
  Settings,
  Shapes,
  Store,
  Ticket,
  TicketPercent,
  Undo2,
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link, usePathname } from '@/i18n/navigation';
import {
  NAV_HREFS,
  activeSidebarKey,
  type NavKey,
  type SidebarSection,
} from '@/lib/admin-nav-model';
import { cn } from '@/lib/utils';

export type { NavKey } from '@/lib/admin-nav-model';

/** PayPal logo mark (Simple Icons, CC0); lucide ships no brand icons. */
export const PayPalIcon = (({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z" />
  </svg>
)) as unknown as LucideIcon;

export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  events: CalendarDays,
  venues: Building2,
  orders: ReceiptText,
  customers: UserRound,
  discounts: TicketPercent,
  refunds: Undo2,
  statistics: ChartLine,
  boxOffice: Store,
  door: ClipboardCheck,
  cashUp: Coins,
  scanners: ScanLine,
  banking: Landmark,
  accounting: Calculator,
  design: Palette,
  settings: Settings,
  administration: Server,
  ticketTemplates: Ticket,
  emailTemplates: Mail,
  media: Images,
  symbols: Shapes,
  fees: Percent,
  waitingRoom: Hourglass,
  users: Users,
  backups: DatabaseBackup,
  system: Activity,
  audit: ScrollText,
};

/** URL + icon per page (used by the shop header's dashboard menu as well). */
export const NAV_ITEMS = Object.fromEntries(
  (Object.keys(NAV_HREFS) as NavKey[]).map((key) => [
    key,
    { href: NAV_HREFS[key], icon: NAV_ICONS[key] },
  ]),
) as Record<NavKey, { href: string; icon: LucideIcon }>;

/** Label message key of a navigation entry (the dashboard is called "Overview" in the sidebar). */
export const navLabelKey = (key: NavKey) => (key === 'dashboard' ? 'overview' : key);

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto rounded-full bg-destructive-solid px-1.5 text-xs font-medium text-destructive-foreground">
      {count}
    </span>
  );
}

/**
 * Sidebar navigation: always expanded sections with small-caps headings (entries filtered by
 * role on the server; hubs carry the summed badge of their pages).
 */
export function AdminNavLinks({ sections }: { sections: SidebarSection[] }) {
  const t = useTranslations('admin.nav');
  const active = activeSidebarKey(usePathname());
  return (
    <nav aria-label={t('label')} className="flex flex-col gap-4">
      {sections.map((section, i) => {
        const headingId = section.heading ? `admin-nav-${section.heading}` : undefined;
        return (
          <div
            key={section.heading ?? `section-${i}`}
            className={cn('flex flex-col gap-0.5', section.separator && 'border-t pt-4')}
          >
            {section.heading && (
              <div
                id={headingId}
                className="px-3 pb-1 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase"
              >
                {t(`groups.${section.heading}`)}
              </div>
            )}
            <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
              {section.items.map(({ key, href, badge }) => {
                const Icon = NAV_ICONS[key];
                const current = active === key;
                return (
                  <li key={key}>
                    <Link
                      href={href}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        current && 'bg-accent font-medium',
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                      {t(navLabelKey(key))}
                      <Badge count={badge} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** Compact navigation for small screens (the sidebar is hidden below the md breakpoint). */
export function AdminMobileMenu({
  sections,
  children,
}: {
  sections: SidebarSection[];
  /** Extra entries (server-rendered). */
  children?: ReactNode;
}) {
  const t = useTranslations('admin.nav');
  const active = activeSidebarKey(usePathname());
  const total = sections.reduce(
    (sum, s) => sum + s.items.reduce((n, item) => n + item.badge, 0),
    0,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t('menu')}>
          <Menu className="size-4" /> <span className="max-sm:sr-only">{t('menu')}</span>
          <Badge count={total} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} className="min-w-60">
        {sections.map((section, i) => (
          <DropdownMenuGroup key={section.heading ?? `section-${i}`}>
            {i > 0 && <DropdownMenuSeparator />}
            {section.heading && (
              <DropdownMenuLabel className="text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase">
                {t(`groups.${section.heading}`)}
              </DropdownMenuLabel>
            )}
            {section.items.map(({ key, href, badge }) => {
              const Icon = NAV_ICONS[key];
              const current = active === key;
              return (
                <DropdownMenuItem key={key} asChild>
                  <Link
                    href={href}
                    aria-current={current ? 'page' : undefined}
                    className={cn(current && 'bg-accent font-medium')}
                  >
                    <Icon className="size-4" />
                    {t(navLabelKey(key))}
                    <Badge count={badge} />
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
        {children && <DropdownMenuSeparator />}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
