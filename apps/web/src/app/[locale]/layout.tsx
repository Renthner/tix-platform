import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { cookies, headers } from 'next/headers';
import {
  DEFAULT_LOCALE_HEADER,
  DARK_BACKGROUND_HEX,
  brandTokens,
  expandTitleTemplate,
  isAppLocale,
  parseThemeCookie,
  resolveTheme,
} from '@tix/shared';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSetting } from '@tix/core';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DefaultLocaleProvider } from '@/i18n/default-locale-context';
import { routing } from '@/i18n/routing';
import { pickMessages } from '@/i18n/messages';
import { getCore } from '@/server/core';
import { getDefaultLocale } from '@/server/default-locale';
import { AREA_HEADER, THEME_BOOT_SCRIPT, THEME_COOKIE } from '@/lib/theme';
import { loadSeoContext, publicBaseUrl } from '@/server/seo';
import '../globals.css';

// Every page depends on admin-managed data (shop name, branding, events) → always render
// on request; nothing is prerendered at build time (the build has no database).
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const core = getCore();
  const [branding, ctx] = await Promise.all([
    getSetting(core, 'branding'),
    params.then(({ locale }) => loadSeoContext(locale)),
  ]);
  const t = await getTranslations('common');
  const { seo } = ctx;
  return {
    // Resolves relative URLs (icons, images) in metadata against the public origin.
    metadataBase: new URL(publicBaseUrl()),
    // Settings → SEO: site title and title template (default "%s · <shop name>").
    title: {
      default: ctx.siteTitle,
      template: expandTitleTemplate(seo.titleTemplate, ctx.siteTitle),
    },
    description: ctx.description ?? t('meta.description'),
    // Indexing switched off: pages without their own robots rule inherit this.
    ...(!ctx.indexing && { robots: { index: false, follow: false } }),
    verification: {
      google: seo.verification.google,
      other: seo.verification.bing ? { 'msvalidate.01': seo.verification.bing } : undefined,
    },
    // Pages that set their own Open Graph / Twitter data (home, events) replace these.
    openGraph: { siteName: ctx.siteTitle, ...(ctx.shareImage && { images: [ctx.shareImage] }) },
    twitter: {
      card: ctx.shareImage ? 'summary_large_image' : 'summary',
      ...(seo.twitterHandle && { site: seo.twitterHandle }),
      ...(ctx.shareImage && { images: [ctx.shareImage.url] }),
    },
    // Shop and admin portal; the asset id in the URL busts caches when the favicon changes.
    icons: {
      icon: branding.faviconAssetId ? `/api/media/${branding.faviconAssetId}` : '/icon.svg',
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const [branding, h] = await Promise.all([getSetting(getCore(), 'branding'), headers()]);
  const tokens = brandTokens(branding.brandColor, branding.brandColorDark);
  const area = h.get(AREA_HEADER) === 'admin' ? 'admin' : 'shop';
  // Browser chrome colour: the brand colour in the light theme, the dark page background in the
  // dark theme; with a fixed theme the matching one only.
  const themeColor =
    area === 'admin' || branding.themeMode === 'VISITOR_CHOICE'
      ? [
          { media: '(prefers-color-scheme: light)', color: tokens.light.primary },
          { media: '(prefers-color-scheme: dark)', color: DARK_BACKGROUND_HEX },
        ]
      : branding.themeMode === 'ALWAYS_DARK'
        ? DARK_BACKGROUND_HEX
        : tokens.light.primary;
  return { width: 'device-width', initialScale: 1, themeColor };
}

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
  const headerLocale = (await headers()).get(DEFAULT_LOCALE_HEADER);
  const defaultLocale =
    headerLocale && isAppLocale(headerLocale) ? headerLocale : await getDefaultLocale();
  const requestHeaders = await headers();
  const area = requestHeaders.get(AREA_HEADER) === 'admin' ? 'admin' : 'shop';
  const branding = await getSetting(getCore(), 'branding');
  const config = { mode: branding.themeMode, defaultTheme: branding.defaultTheme };
  // The shop theme follows Settings → Appearance (fixed, or the default for visitors without a
  // choice); the admin portal always uses the admin's own choice.
  const cookieChoice = parseThemeCookie((await cookies()).get(THEME_COOKIE)?.value);
  const { preference: theme } = resolveTheme({ area, config, cookie: cookieChoice });
  // Explicit themes are rendered here (no flash); "system" is resolved by the boot script in
  // <head> before first paint.
  const nonce = requestHeaders.get('x-nonce') ?? undefined;
  // Brand colour variables (light + computed/overridden dark); CSS applies them to the shop only.
  const brand = brandTokens(branding.brandColor, branding.brandColorDark);
  const brandVars = {
    '--brand-light': brand.light.primary,
    '--brand-fg-light': brand.light.foreground,
    '--brand-dark': brand.dark.primary,
    '--brand-fg-dark': brand.dark.foreground,
  } as React.CSSProperties;
  return (
    <html
      lang={locale}
      data-theme={theme}
      data-area={area}
      className={theme === 'dark' ? 'dark' : undefined}
      style={theme === 'system' ? brandVars : { ...brandVars, colorScheme: theme }}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <ThemeProvider config={config} initialChoice={cookieChoice}>
          <NextIntlClientProvider messages={await pickMessages(['common'])}>
            <DefaultLocaleProvider value={defaultLocale}>
              <TooltipProvider>{children}</TooltipProvider>
              <Toaster richColors position="top-center" />
            </DefaultLocaleProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
