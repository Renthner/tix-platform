import { getSetting } from '@tix/core';
import { UserRound } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { CookieNotice } from '@/components/shop/cookie-notice';
import { COOKIE_NOTICE_COOKIE } from '@/lib/cookie-inventory';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { AdminMenu } from '@/components/shop/admin-menu';
import { CartProvider } from '@/components/shop/cart-context';
import { HeaderCart } from '@/components/shop/header-cart';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { pickMessages } from '@/i18n/messages';
import { allowedNavKeys } from '@/lib/admin-nav-access';
import { getAdminSession } from '@/server/auth';
import { getCore } from '@/server/core';
import { getCustomerSession } from '@/server/customer-session';
import { readMaintenance } from '@/server/maintenance-gate';
import { descriptionToHtml } from '@/server/rich-text';
import { FOOTER_RICH_TEXT_CLASS } from '@/lib/rich-text-styles';
import { cn } from '@/lib/utils';
import { PresenceBeacon } from '@/components/shop/presence-beacon';

export default async function ShopLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const locale = await resolveLocale(params);
  const core = getCore();
  const [
    general,
    branding,
    t,
    accounts,
    customer,
    tAccount,
    tAdminNav,
    adminSession,
    maintenance,
    cookieNotice,
    tCookies,
    cookieJar,
  ] = await Promise.all([
    getSetting(core, 'general'),
    getSetting(core, 'branding'),
    getTranslations('shop.layout'),
    getSetting(core, 'customerAccounts'),
    getCustomerSession(),
    getTranslations('account.nav'),
    getTranslations('admin.nav'),
    getAdminSession(),
    readMaintenance(),
    getSetting(core, 'cookieNotice'),
    getTranslations('shop.cookies'),
    cookies(),
  ]);
  const showCookieNotice =
    cookieNotice.enabled && cookieJar.get(COOKIE_NOTICE_COOKIE)?.value !== '1';
  // Signed-in admin users get a dashboard button (never while a restore holds the system).
  const adminMenu = adminSession && !maintenance.active ? adminSession : null;
  const footerHtml = descriptionToHtml(branding.footerText);
  const legal = [
    { href: branding.imprintUrl, label: t('imprint') },
    { href: branding.privacyUrl, label: t('privacy') },
    { href: branding.termsUrl, label: t('terms') },
  ].filter((l): l is { href: string; label: string } => !!l.href);

  return (
    <NextIntlClientProvider
      messages={await pickMessages([
        'common',
        'shop',
        'queue',
        'cart',
        'checkout',
        'account',
        'admin',
      ])}
    >
      <CartProvider>
        {!adminSession && <PresenceBeacon />}
        <div className="flex min-h-dvh flex-col">
          <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-4">
              <Link
                href="/"
                className="min-w-0 truncate font-semibold"
                style={{ color: branding.primaryColor }}
              >
                {branding.logoAssetId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${branding.logoAssetId}`}
                    alt={general.shopName}
                    className="h-9 w-auto max-w-28 object-contain sm:max-w-56"
                  />
                ) : (
                  general.shopName
                )}
              </Link>
              <nav className="hidden flex-1 sm:block">
                <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
                  {t('events')}
                </Link>
              </nav>
              <div className="flex-1 sm:hidden" />
              {accounts.enabled && (
                <Link
                  href={customer ? '/account' : '/account/login'}
                  className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent sm:px-3"
                >
                  <UserRound className="size-4" />
                  <span className="hidden sm:inline">
                    {customer ? tAccount('myAccount') : tAccount('signIn')}
                  </span>
                </Link>
              )}
              <HeaderCart />
              <LocaleSwitcher />
              {adminMenu && (
                <AdminMenu
                  label={
                    adminMenu.twoFactorSetupRequired
                      ? tAccount('dashboardSetup')
                      : tAccount('dashboard')
                  }
                  entries={
                    adminMenu.twoFactorSetupRequired
                      ? []
                      : allowedNavKeys(adminMenu.roles).map((key) => ({
                          key,
                          label: tAdminNav(key),
                        }))
                  }
                  setupRequired={adminMenu.twoFactorSetupRequired}
                  signOutLabel={tAccount('signOut')}
                />
              )}
            </div>
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
          {showCookieNotice && (
            <CookieNotice
              text={cookieNotice.texts[locale] || tCookies('notice')}
              moreLabel={tCookies('learnMore')}
              dismissLabel={tCookies('dismiss')}
            />
          )}
          <footer className="border-t py-6 text-sm text-muted-foreground">
            <div className="mx-auto flex max-w-7xl flex-wrap items-start gap-x-6 gap-y-3 px-4">
              {footerHtml ? (
                <div
                  className={cn('min-w-0 flex-1', FOOTER_RICH_TEXT_CLASS)}
                  // Sanitised with the rich-text allowlist (also on save).
                  dangerouslySetInnerHTML={{ __html: footerHtml }}
                />
              ) : (
                <span className="flex-1">{general.shopName}</span>
              )}
              {legal.map((l) => (
                <a key={l.label} href={l.href} className="hover:underline" rel="noopener">
                  {l.label}
                </a>
              ))}
              <Link href="/cookies" className="hover:underline">
                {t('cookies')}
              </Link>
            </div>
          </footer>
        </div>
      </CartProvider>
    </NextIntlClientProvider>
  );
}
