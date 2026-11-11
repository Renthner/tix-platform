import { LogOut, Store } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getSetting } from '@tix/core';
import { APP_VERSION } from '@tix/shared';
import { logoutAction } from '@/components/admin/admin-actions';
import { AdminNav } from '@/components/admin/admin-nav';
import { LocaleSwitcher } from '@/components/locale-switcher';
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
  const [t, general] = await Promise.all([
    getTranslations('admin'),
    getSetting(getCore(), 'general'),
  ]);
  return (
    <NextIntlClientProvider
      messages={await pickMessages([
        'common',
        'admin',
        'editor',
        'orders',
        'fees',
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
      ])}
    >
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-muted/30 p-4 md:flex">
          <div className="mb-6 shrink-0 px-3">
            <div className="text-sm font-semibold">{general.shopName}</div>
            <div className="text-xs text-muted-foreground">{t('panelTitle')}</div>
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
              v{APP_VERSION}
            </div>
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
            <LocaleSwitcher />
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm" className="w-full justify-start px-0">
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
              <Button asChild variant="outline" size="sm">
                <Link href="/">
                  <Store className="size-4" /> {t('shopLink')}
                </Link>
              </Button>
            </div>
          </div>
          <main>
            {session.twoFactorSetupRequired ? (
              <AccountContent userId={session.userId} setupRequired />
            ) : (
              children
            )}
          </main>
        </div>
      </div>
    </NextIntlClientProvider>
  );
}
