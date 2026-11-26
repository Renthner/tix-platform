'use client';

import { Bell, CheckCircle2, ExternalLink, LogOut, Plus, Store, UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { logoutAction } from '@/components/admin/admin-actions';
import { LocaleMenuItems } from '@/components/locale-switcher';
import { ThemeMenuItems } from '@/components/theme-switcher';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

/** Notification bell: total of the open to-dos and a list of them with deep links. */
export function NotificationBell({
  items,
}: {
  items: { key: string; label: string; count: number; href: string }[];
}) {
  const t = useTranslations('admin.shell.bell');
  const total = items.reduce((sum, i) => sum + i.count, 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="relative h-8 w-8 px-0"
          aria-label={total > 0 ? t('labelCount', { count: total }) : t('label')}
          data-testid="admin-bell"
        >
          <Bell className="size-4" aria-hidden />
          {total > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-destructive-solid px-1 text-center text-[0.65rem] leading-4 font-medium text-destructive-foreground"
              aria-hidden
            >
              {total > 99 ? '99+' : total}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="w-72">
        <DropdownMenuLabel>{t('title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4" aria-hidden />
            {t('empty')}
          </div>
        ) : (
          items.map((item) => (
            <DropdownMenuItem key={item.key} asChild>
              <Link href={item.href} className="flex items-center justify-between gap-3">
                <span className="text-sm">{item.label}</span>
                <span className="rounded-full bg-muted px-2 text-xs font-medium tabular-nums">
                  {item.count}
                </span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/admin">{t('dashboard')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "+ New" menu: quick create entries the user may open. */
export function NewMenu({ items }: { items: { key: string; label: string; href: string }[] }) {
  const t = useTranslations('admin.shell.create');
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="h-8" data-testid="admin-new-menu">
          <Plus className="size-4" aria-hidden />
          <span className="max-sm:sr-only">{t('button')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="min-w-52">
        {items.map((item) => (
          <DropdownMenuItem key={item.key} asChild>
            <Link href={item.href}>{item.label}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function initials(name: string, email: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? `${parts[0]![0]}${parts[parts.length - 1]![0]}`
      : (parts[0] ?? email).slice(0, 2);
  return letters.toUpperCase();
}

/**
 * User menu (initials button): name + e-mail, own account, shop link, language, theme, version
 * and sign-out. `limited` = forced two-factor setup (only account + sign-out make sense).
 */
export function UserMenu({
  name,
  email,
  version,
  limited = false,
}: {
  name: string;
  email: string;
  version: string;
  limited?: boolean;
}) {
  const t = useTranslations('admin.shell.user');
  const tAdmin = useTranslations('admin');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 rounded-full px-0 text-xs font-semibold"
          aria-label={t('label', { name })}
          data-testid="admin-user-menu"
        >
          {initials(name, email)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="w-64">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/admin/account">
            <UserRound className="size-4" aria-hidden />
            {t('account')}
          </Link>
        </DropdownMenuItem>
        {!limited && (
          <DropdownMenuItem asChild>
            <Link href="/">
              <Store className="size-4" aria-hidden />
              <span className="flex-1">{tAdmin('shopLink')}</span>
              <ExternalLink className="size-3 opacity-60" aria-hidden />
            </Link>
          </DropdownMenuItem>
        )}
        {routing.locales.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {t('language')}
            </DropdownMenuLabel>
            <LocaleMenuItems />
          </>
        )}
        <DropdownMenuSeparator />
        <ThemeMenuItems />
        <DropdownMenuSeparator />
        <div className="px-2 py-1 font-mono text-xs text-muted-foreground">
          {t('version', { version })}
        </div>
        <form action={logoutAction}>
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full">
              <LogOut className="size-4" aria-hidden />
              {tAdmin('logout')}
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
