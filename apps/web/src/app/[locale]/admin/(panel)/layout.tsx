import { LogOut, Store } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getLoadTestStatus, getSetting } from '@tix/core';
import { APP_VERSION } from '@tix/shared';
import { logoutAction } from '@/components/admin/admin-actions';
import { AdminNav } from '@/components/admin/admin-nav';
import { UnsavedChangesProvider } from '@/components/admin/unsaved-changes';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { SkipLink } from '@/components/skip-link';
import { AccountContent } from '@/components/admin/account/account-content';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { resolveLocale } from '@/i18n/locale';
import { pickMessages } from '@/i18n/messages';
import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminPanelLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  // While two-factor setup is enforced, only the account page content is shown (see below).
  const session = await requireAdmin([], {
    allowTwoFactorSetup: true,
    allowIncompleteRestore: true,
  });
  const [t, tSystem, format, general, loadTest, tA11y] = await Promise.all([
    getTranslations('admin'),
    getTranslations('system.loadTest'),
    getFormatter(),
    getSetting(getCore(), 'general'),
    // Banner while the load test mode is on (one Redis read; never blocks the panel).
    getLoadTestStatus(getCore()).catch(() => ({ active: false as const })),
    getTranslations('common.a11y'),
  ]);
  return (
    <NextIntlClientProvider
      messages={await pickMessages([
        'common',
        'admin',
        'editor',
        'orders',
        'fees',
        'discounts',
        'discount',
        'emailTemplates',
        'ticketDesigner',
        'adminSecurity',
        'customers',
        'backups',
        'accounting',
        'shop',
        'cart',
        'banking',
        'translations',
        'checkout',
        'scanners',
        'statistics',
        'system',
        'communication',
      ])}
    >
      <UnsavedChangesProvider>
        <SkipLink label={tA11y('skipToContent')} />
        <div className="flex min-h-dvh">
          <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-muted/30 p-4 md:flex">
            <div className="mb-6 shrink-0 px-3">
              <div className="text-sm font-semibold">{general.shopName}</div>
              <div className="text-xs text-muted-foreground">{t('panelTitle')}</div>
              <div className="mt-0.5 font-mono text-xs text-muted-foreground">v{APP_VERSION}</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AdminNav />
            </div>
            <div className="mt-3 shrink-0 space-y-3 px-3 text-xs text-muted-foreground">
              <Link
                href="/admin/account"
                className="block truncate hover:text-foreground hover:underline"
                title={session.email}
              >
                {session.displayName}
              </Link>
              <div className="flex items-center gap-2">
                <LocaleSwitcher />
                <ThemeSwitcher />
              </div>
              <form action={logoutAction}>
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start px-0"
                >
                  <LogOut className="size-4" /> {t('logout')}
                </Button>
              </form>
            </div>
          </aside>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-2 md:justify-end">
              <div className="md:hidden">
                <AdminNav
                  mobile
                  mobileFooter={
                    <form action={logoutAction}>
                      <DropdownMenuItem asChild>
                        <button type="submit" className="w-full">
                          <LogOut className="size-4" /> {t('logout')}
                        </button>
                      </DropdownMenuItem>
                    </form>
                  }
                />
              </div>
              <div className="flex items-center gap-2">
                <div className="md:hidden">
                  <LocaleSwitcher />
                </div>
                <div className="md:hidden">
                  <ThemeSwitcher />
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href="/">
                    <Store className="size-4" />{' '}
                    <span className="max-[420px]:sr-only">{t('shopLink')}</span>
                  </Link>
                </Button>
              </div>
            </div>
            {loadTest.active && 'expiresAt' in loadTest && loadTest.expiresAt && (
              <div
                role="alert"
                data-testid="load-test-banner"
                className="flex flex-wrap items-center justify-between gap-2 border-b bg-destructive px-4 py-2 text-sm text-white"
              >
                <span>
                  {tSystem('banner', {
                    time: format.dateTime(loadTest.expiresAt, { timeStyle: 'short' }),
                  })}
                </span>
                <Link href="/admin/system" className="font-medium underline">
                  {tSystem('bannerLink')}
                </Link>
              </div>
            )}
            <main id="main" tabIndex={-1} className="focus:outline-none">
              {session.twoFactorSetupRequired ? (
                <AccountContent userId={session.userId} setupRequired />
              ) : (
                children
              )}
            </main>
          </div>
        </div>
      </UnsavedChangesProvider>
    </NextIntlClientProvider>
  );
}
