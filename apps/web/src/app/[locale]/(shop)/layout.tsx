import { getSetting } from '@tix/core';
import { protectEmailsInHtml } from '@tix/shared';
import { Ticket, UserRound } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { CookieNotice } from '@/components/shop/cookie-notice';
import { COOKIE_NOTICE_COOKIE } from '@/lib/cookie-inventory';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { DisplayMenu } from '@/components/shop/display-menu';
import { routing } from '@/i18n/routing';
import { AdminMenu } from '@/components/shop/admin-menu';
import { CartProvider } from '@/components/shop/cart-context';
import { HeaderCart } from '@/components/shop/header-cart';
import { headerLinkClass } from '@/components/shop/header-styles';
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
  // On phones the admin dropdown carries the language / theme items (one header button less).
  const adminAbsorbsDisplay = !!adminMenu && !adminMenu.twoFactorSetupRequired;
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
            <div className="mx-auto flex min-h-14 max-w-7xl flex-nowrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 sm:gap-x-4 sm:px-4">
              {/* Brand group: logo (or shop name) and the sponsors. Takes what the controls leave. */}
              <div className="flex min-w-28 flex-1 items-center gap-2 sm:gap-4">
                <Link
                  href="/"
                  className={cn(
                    'tix-brand-text min-w-0 text-base font-semibold sm:text-lg',
                    // With sponsors the logo yields space to them on phones.
                    hasSponsors ? 'max-w-[40%] shrink-0 truncate' : 'truncate',
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
              </div>
              {/* Controls: navigation items first (ghost), then the utility buttons (outlined). */}
              <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1.5">
                {/* Phones: the logo already leads to the event list. */}
                <nav aria-label={t('mainNavigation')} className="hidden sm:block">
                  <Link href="/" title={t('events')} className={headerLinkClass}>
                    <Ticket className="size-4" aria-hidden />
                    <span className="max-lg:sr-only">{t('events')}</span>
                  </Link>
                </nav>
                {accounts.enabled && (
                  <Link
                    href={customer ? '/account' : '/account/login'}
                    title={customer ? tAccount('myAccount') : tAccount('signIn')}
                    className={headerLinkClass}
                  >
                    <UserRound className="size-4" aria-hidden />
                    <span className="max-lg:sr-only">
                      {customer ? tAccount('myAccount') : tAccount('signIn')}
                    </span>
                  </Link>
                )}
                <HeaderCart />
                <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-border sm:block" />
                {/* Phones: language + theme share ONE menu button; from `sm` up two switchers. */}
                <DisplayMenu
                  showTheme={!themeFixed}
                  className={adminAbsorbsDisplay ? 'hidden' : 'sm:hidden'}
                />
                {routing.locales.length > 1 && <LocaleSwitcher className="h-9 max-sm:hidden" />}
                {!themeFixed && <ThemeSwitcher className="size-9 max-sm:hidden" />}
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
                    showTheme={!themeFixed}
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
          <footer className="border-t bg-muted/30 text-sm text-muted-foreground">
            <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 md:flex-row md:items-start md:justify-between md:gap-10 md:py-6">
              {footerHtml ? (
                <div
                  className={cn(
                    'tix-rt min-w-0 max-w-prose [overflow-wrap:anywhere] md:max-w-3xl md:flex-1',
                    FOOTER_RICH_TEXT_CLASS,
                  )}
                  // Sanitised with the rich-text allowlist (also on save).
                  dangerouslySetInnerHTML={{ __html: protectEmailsInHtml(footerHtml) }}
                />
              ) : (
                <span className="min-w-0 [overflow-wrap:anywhere] md:flex-1">
                  {general.shopName}
                </span>
              )}
              {/* Legal links: one wrapping row with dot separators; on phones set off by a rule. */}
              <nav
                aria-label={t('legalNavigation')}
                className="border-t pt-3 md:max-w-md md:shrink-0 md:border-t-0 md:pt-0"
              >
                <ul className="flex flex-wrap items-center gap-x-2 gap-y-1 md:justify-end">
                  {legal.map((l) => (
                    <li
                      key={l.label}
                      className="after:ml-2 after:text-border after:content-['•'] last:after:content-none"
                    >
                      <a
                        href={l.href}
                        className="py-1 hover:text-foreground hover:underline"
                        rel="noopener"
                      >
                        {l.label}
                      </a>
                    </li>
                  ))}
                  <li>
                    <Link href="/cookies" className="py-1 hover:text-foreground hover:underline">
                      {t('cookies')}
                    </Link>
                  </li>
                </ul>
              </nav>
            </div>
          </footer>
        </div>
      </CartProvider>
    </NextIntlClientProvider>
  );
}
