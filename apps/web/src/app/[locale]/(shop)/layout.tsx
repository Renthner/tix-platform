import { getSetting } from '@tix/core';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { CartProvider } from '@/components/shop/cart-context';
import { HeaderCart } from '@/components/shop/header-cart';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { pickMessages } from '@/i18n/messages';
import { getCore } from '@/server/core';

export default async function ShopLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  const core = getCore();
  const [general, branding, t] = await Promise.all([
    getSetting(core, 'general'),
    getSetting(core, 'branding'),
    getTranslations('shop.layout'),
  ]);
  const legal = [
    { href: branding.imprintUrl, label: t('imprint') },
    { href: branding.privacyUrl, label: t('privacy') },
    { href: branding.termsUrl, label: t('terms') },
  ].filter((l): l is { href: string; label: string } => !!l.href);

  return (
    <NextIntlClientProvider messages={await pickMessages(['common', 'shop', 'queue', 'cart'])}>
      <CartProvider>
        <div className="flex min-h-dvh flex-col">
          <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
              <Link href="/" className="font-semibold" style={{ color: branding.primaryColor }}>
                {general.shopName}
              </Link>
              <nav className="flex-1">
                <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
                  {t('events')}
                </Link>
              </nav>
              <HeaderCart />
              <LocaleSwitcher />
            </div>
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
          <footer className="border-t py-6 text-sm text-muted-foreground">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4">
              <span>{branding.footerText ?? general.shopName}</span>
              {legal.map((l) => (
                <a key={l.label} href={l.href} className="hover:underline" rel="noopener">
                  {l.label}
                </a>
              ))}
            </div>
          </footer>
        </div>
      </CartProvider>
    </NextIntlClientProvider>
  );
}
