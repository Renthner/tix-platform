import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSetting } from '@tix/core';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { routing } from '@/i18n/routing';
import { pickMessages } from '@/i18n/messages';
import { getCore } from '@/server/core';
import '../globals.css';

// Every page depends on admin-managed data (shop name, branding, events) → always render
// on request; nothing is prerendered at build time (the build has no database).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const core = getCore();
  const [general, branding] = await Promise.all([
    getSetting(core, 'general'),
    getSetting(core, 'branding'),
  ]);
  const t = await getTranslations('common');
  return {
    title: { default: general.shopName, template: `%s · ${general.shopName}` },
    description: t('meta.description'),
    // Shop and admin portal; the asset id in the URL busts caches when the favicon changes.
    icons: {
      icon: branding.faviconAssetId ? `/api/media/${branding.faviconAssetId}` : '/icon.svg',
    },
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-dvh">
        <NextIntlClientProvider messages={await pickMessages(['common'])}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster richColors position="top-center" />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
