import { LogOut } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getSetting } from '@tix/core';
import { logoutAction } from '@/components/admin/admin-actions';
import { AdminNav } from '@/components/admin/admin-nav';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Button } from '@/components/ui/button';
import { resolveLocale } from '@/i18n/locale';
import { pickMessages } from '@/i18n/messages';
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
  const session = await requireAdmin();
  const [t, general] = await Promise.all([
    getTranslations('admin'),
    getSetting(getCore(), 'general'),
  ]);
  return (
    <NextIntlClientProvider messages={await pickMessages(['common', 'admin', 'editor'])}>
      <div className="flex min-h-dvh">
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-muted/30 p-4 md:flex">
          <div className="mb-6 px-3">
            <div className="text-sm font-semibold">{general.shopName}</div>
            <div className="text-xs text-muted-foreground">{t('panelTitle')}</div>
          </div>
          <AdminNav />
          <div className="mt-auto space-y-3 px-3 text-xs text-muted-foreground">
            <div className="truncate" title={session.email}>
              {session.displayName}
            </div>
            <LocaleSwitcher />
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm" className="w-full justify-start px-0">
                <LogOut className="size-4" /> {t('logout')}
              </Button>
            </form>
          </div>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </NextIntlClientProvider>
  );
}
