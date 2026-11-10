'use client';

import { ChevronDown, LayoutDashboard, LogOut, ShieldCheck } from 'lucide-react';
import { signOutAdminAction } from './admin-menu-actions';
import { NAV_ITEMS, type NavKey } from '@/components/admin/admin-nav-links';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/i18n/navigation';

/**
 * Shop header entry for signed-in admin users: "To dashboard" plus a menu of the admin pages
 * this user may open (labels are translated on the server; the role filter is `allowedNavKeys`).
 * `entries` is empty while the forced two-factor setup is open: the button then leads to the
 * account page where the setup happens.
 */
export function AdminMenu({
  label,
  entries,
  setupRequired,
  signOutLabel,
}: {
  label: string;
  entries: { key: NavKey; label: string }[];
  setupRequired: boolean;
  signOutLabel: string;
}) {
  const home = setupRequired ? '/admin/account' : '/admin';
  return (
    <div className="flex items-center">
      <Button asChild variant="outline" size="sm" className={setupRequired ? '' : 'rounded-r-none'}>
        <Link href={home}>
          {setupRequired ? <ShieldCheck /> : <LayoutDashboard />}
          <span className="hidden sm:inline">{label}</span>
        </Link>
      </Button>
      {!setupRequired && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="-ml-px rounded-l-none px-2"
              aria-label={label}
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {entries.map(({ key, label: entryLabel }) => {
              const { href, icon: Icon } = NAV_ITEMS[key];
              return (
                <DropdownMenuItem key={key} asChild>
                  <Link href={href}>
                    <Icon className="size-4" />
                    {entryLabel}
                  </Link>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <form action={signOutAdminAction}>
              <DropdownMenuItem asChild>
                <button type="submit" className="w-full">
                  <LogOut className="size-4" />
                  {signOutLabel}
                </button>
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
