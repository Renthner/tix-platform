import { getSetting } from '@tix/core';
import { protectEmailsInHtml } from '@tix/shared';
import { UserRound } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { CookieNotice } from '@/components/shop/cookie-notice';
import { COOKIE_NOTICE_COOKIE } from '@/lib/cookie-inventory';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';
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
import { QUEUE_TEST_COOKIE } from '@/server/shop-actor';
import { descriptionToHtml } from '@/server/rich-text';
import { FOOTER_RICH_TEXT_CLASS } from '@/lib/rich-text-styles';
import { MediaThumb } from '@/components/media-image';
import { cn } from '@/lib/utils';
import { PresenceBeacon } from '@/components/shop/presence-beacon';
import { HeaderSponsors, type SponsorView } from '@/components/shop/header-sponsors';

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
    sponsors,
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
    getSetting(core, 'sponsors'),
  ]);
  const showCookieNotice =
    cookieNotice.enabled && cookieJar.get(COOKIE_NOTICE_COOKIE)?.value !== '1';
  // Signed-in admin users get a dashboard button (never while a restore holds the system).
  const adminMenu = adminSession && !maintenance.active ? adminSession : null;
  const footerHtml = descriptionToHtml(branding.footerText);
  // Theme fixed by the operator: no theme switch anywhere in the shop header.
  const themeFixed = branding.themeMode !== 'VISITOR_CHOICE';
  const sponsorItems: SponsorView[] = sponsors.enabled
    ? sponsors.items.map((s) => ({
        id: s.id,
        assetId: s.assetId,
        width: s.assetWidth,
        height: s.assetHeight,
        alt: s.alt[locale as 'en' | 'de'] || s.alt[general.defaultLocale as 'en' | 'de'] || '',
        href: s.url,
        seconds: s.durationSeconds,
      }))
    : [];
  const sponsorLabel =
    sponsors.label[locale as 'en' | 'de'] ||
    sponsors.label[general.defaultLocale as 'en' | 'de'] ||
    '';
  const hasSponsors = sponsorItems.length > 0;
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
        // Only what the client components of the shop read (admin menu, form feedback): the whole
        // admin namespace is ~70 KB per page view.
        'admin.nav',
        'admin.errors',
        'admin.messages',
      ])}
    >
      <CartProvider>
        {!adminSession && <PresenceBeacon />}
        <div className="flex min-h-dvh flex-col">
          <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
            <div className="mx-auto flex min-h-14 max-w-7xl items-center gap-1 px-3 py-1.5 sm:gap-4 sm:px-4">
              <Link
                href="/"
                className={cn(
                  'tix-brand-text min-w-0 font-semibold',
                  // With sponsors the logo yields space to them on phones.
                  hasSponsors ? 'max-w-[30%] shrink-0 truncate' : 'truncate',
                )}
                style={{ '--tix-h': `${branding.logoHeight}px` } as React.CSSProperties}
              >
                {branding.logoAssetId ? (
                  <MediaThumb
                    assetId={branding.logoAssetId}
                    variantWidth={640}
                    loading="eager"
                    alt={general.shopName}
                    className={cn(
                      'tix-header-image w-auto object-contain',
                      hasSponsors ? 'max-w-full' : 'max-w-[45vw] sm:max-w-80',
                    )}
                  />
                ) : (
                  general.shopName
                )}
              </Link>
              {hasSponsors && (
                <HeaderSponsors
                  items={sponsorItems}
                  height={sponsors.height}
                  label={sponsorLabel}
                  regionLabel={t('sponsors')}
                  previousLabel={t('sponsorPrevious')}
                  nextLabel={t('sponsorNext')}
                />
              )}
              {/* Both fill the space up to the controls (the nav link is hidden on phones). */}
              <nav className="hidden min-w-0 flex-1 sm:block sm:pl-2">
                <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
                  {t('events')}
                </Link>
              </nav>
              <div className="flex-1 sm:hidden" />
              {accounts.enabled && (
                <Link
                  href={customer ? '/account' : '/account/login'}
                  className="flex items-center gap-2 rounded-md px-1.5 py-2 text-sm hover:bg-accent sm:px-3"
                >
                  <UserRound className="size-4" />
                  <span className="hidden sm:inline">
                    {customer ? tAccount('myAccount') : tAccount('signIn')}
                  </span>
                </Link>
              )}
              <HeaderCart />
              <LocaleSwitcher />
              {/* With the admin dropdown the theme items live there below 480px. */}
              {!themeFixed && (
                <div
                  className={
                    adminMenu && !adminMenu.twoFactorSetupRequired
                      ? 'max-[479px]:hidden'
                      : undefined
                  }
                >
                  <ThemeSwitcher />
                </div>
              )}
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
                  hideTheme={themeFixed}
                  signOutLabel={tAccount('signOut')}
                  queueTest={
                    !adminMenu.twoFactorSetupRequired && adminMenu.roles.includes('SUPER_ADMIN')
                      ? {
                          enabled: cookieJar.get(QUEUE_TEST_COOKIE)?.value === '1',
                          label: tAccount('queueTest'),
                          stateLabel:
                            cookieJar.get(QUEUE_TEST_COOKIE)?.value === '1'
                              ? tAccount('queueTestOn')
                              : tAccount('queueTestOff'),
                        }
                      : undefined
                  }
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
                  className={cn('tix-rt min-w-0 flex-1', FOOTER_RICH_TEXT_CLASS)}
                  // Sanitised with the rich-text allowlist (also on save).
                  dangerouslySetInnerHTML={{ __html: protectEmailsInHtml(footerHtml) }}
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
