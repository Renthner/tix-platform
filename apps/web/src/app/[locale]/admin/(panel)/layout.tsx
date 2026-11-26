import { NextIntlClientProvider } from 'next-intl';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getLoadTestStatus, getSetting } from '@tix/core';
import { APP_VERSION } from '@tix/shared';
import { AdminNav } from '@/components/admin/admin-nav';
import { CommandPalette } from '@/components/admin/command-palette';
import { NewMenu, NotificationBell, UserMenu } from '@/components/admin/topbar-menus';
import { UnsavedChangesProvider } from '@/components/admin/unsaved-changes';
import { SkipLink } from '@/components/skip-link';
import { AccountContent } from '@/components/admin/account/account-content';
import { resolveLocale } from '@/i18n/locale';
import { pickMessages } from '@/i18n/messages';
import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/server/auth';
import { buildPaletteEntries } from '@/server/admin/palette';
import { loadAdminShellData } from '@/server/admin/shell';
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
  const [t, tSystem, format, general, loadTest, tA11y, shell] = await Promise.all([
    getTranslations('admin'),
    getTranslations('system.loadTest'),
    getFormatter(),
    getSetting(getCore(), 'general'),
    // Banner while the load test mode is on (one Redis read; never blocks the panel).
    getLoadTestStatus(getCore()).catch(() => ({ active: false as const })),
    getTranslations('common.a11y'),
    // Null while the two-factor setup is forced: no navigation, search, to-dos or quick create.
    loadAdminShellData(),
  ]);
  const paletteEntries = shell ? await buildPaletteEntries(shell.keys, session.roles) : [];
  // Quick create entries (same role rules as the target pages).
  const createItems = shell
    ? (
        [
          ['event', 'events', '/admin/events/new'],
          ['boxOffice', 'boxOffice', '/admin/box-office'],
          ['discount', 'discounts', '/admin/discounts#create'],
          ['venue', 'venues', '/admin/venues/new'],
        ] as const
      )
        .filter(([, key]) => shell.keys.includes(key))
        .map(([id, , href]) => ({ key: id, label: t(`shell.create.${id}`), href }))
    : [];
  const bellItems = (shell?.todos ?? []).map((todo) => ({
    ...todo,
    label: t(`shell.bell.items.${todo.key}`),
  }));
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
            <Link
              href="/admin"
              className="mb-5 block shrink-0 rounded-md px-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="block text-sm font-semibold">{general.shopName}</span>
              <span className="block text-xs text-muted-foreground">{t('panelTitle')}</span>
            </Link>
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
              <AdminNav />
            </div>
          </aside>
          {/* Pages marked `data-admin-panes` (settings tab pages, event pages) get a viewport-high column on
              md+: header and banner keep their height, `<main>` takes the rest and the page
              scrolls its own panes, so the window never scrolls there. Other pages scroll the
              window as usual. */}
          <div className="min-w-0 flex-1 md:has-data-admin-panes:flex md:has-data-admin-panes:h-dvh md:has-data-admin-panes:flex-col">
            <header
              className="flex items-center gap-2 border-b px-4 py-2"
              data-testid="admin-topbar"
            >
              {shell && (
                <div className="md:hidden">
                  <AdminNav mobile />
                </div>
              )}
              {shell && (
                <div className="min-w-0 flex-1">
                  <CommandPalette entries={paletteEntries} />
                </div>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {shell && <NotificationBell items={bellItems} />}
                {shell && <NewMenu items={createItems} />}
                <UserMenu
                  name={session.displayName}
                  email={session.email}
                  version={APP_VERSION}
                  limited={!shell}
                />
              </div>
            </header>
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
            <main
              id="main"
              tabIndex={-1}
              className="focus:outline-none md:has-data-admin-panes:flex md:has-data-admin-panes:min-h-0 md:has-data-admin-panes:flex-1 md:has-data-admin-panes:flex-col md:has-data-admin-panes:overflow-hidden"
            >
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
