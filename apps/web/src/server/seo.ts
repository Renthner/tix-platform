import 'server-only';
import { contentLocale, getSetting, getShopMediaAsset } from '@tix/core';
import {
  SUPPORTED_LOCALES,
  localizedPath,
  resolveSeoDescription,
  resolveSiteTitle,
} from '@tix/shared';
import type { Metadata } from 'next';
import { cache } from 'react';
import { getCore } from '@/server/core';
import { getEnv } from '@/server/env';
import { richTextToPlain } from '@/server/rich-text';

/** Public origin of the installation (`APP_URL`), without a trailing slash. */
export function publicBaseUrl(): string {
  return getEnv().APP_URL.replace(/\/+$/, '');
}

/** Content locale + live shop default locale, resolved once per request. */
export const loadContentLocale = cache((locale: string) => contentLocale(getCore(), locale));

/**
 * Settings → SEO resolved for one request: indexing switch, site title / description of the
 * content locale, default share image and Twitter handle. Settings reads are cached by core.
 */
export const loadSeoContext = cache(async (locale: string) => {
  const core = getCore();
  const content = await loadContentLocale(locale);
  const [seo, general] = await Promise.all([getSetting(core, 'seo'), getSetting(core, 'general')]);
  const shareAsset = seo.shareImageAssetId
    ? await getShopMediaAsset(core, seo.shareImageAssetId)
    : null;
  return {
    seo,
    content,
    indexing: seo.indexing,
    shopName: general.shopName,
    siteTitle: resolveSiteTitle(seo, content.locale, content.defaultLocale, general.shopName),
    description: resolveSeoDescription(seo, content.locale, content.defaultLocale),
    shareImage: shareAsset
      ? {
          url: `${publicBaseUrl()}/api/media/${shareAsset.id}`,
          width: shareAsset.width ?? undefined,
          height: shareAsset.height ?? undefined,
        }
      : undefined,
  };
});

/** Absolute URL of `path` in `locale` (default locale unprefixed). */
export function localeUrl(locale: string, path: string, defaultLocale: string): string {
  return `${publicBaseUrl()}${localizedPath(locale, path, defaultLocale)}`;
}

/** hreflang map for every supported locale plus `x-default` (= the shop default locale). */
export function languageAlternates(path: string, defaultLocale: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const l of SUPPORTED_LOCALES) languages[l] = localeUrl(l, path, defaultLocale);
  languages['x-default'] = localeUrl(defaultLocale, path, defaultLocale);
  return languages;
}

/** Open Graph locale tags (language_TERRITORY); unknown locales fall back to the bare tag. */
const OG_LOCALES: Record<string, string> = { en: 'en_US', de: 'de_DE' };

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Plain text of a rich-text/HTML field, entities decoded, cut at a word boundary. */
export function plainSnippet(html: string | null | undefined, max = 160): string {
  const text = richTextToPlain(html)
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface PageSeo {
  /** Locale-neutral path ("/", "/events/foo"). */
  path: string;
  locale: string;
  defaultLocale: string;
  title: string;
  description?: string;
  siteName: string;
  /** Absolute image URL + known size. */
  image?: { url: string; width?: number | null; height?: number | null };
  /** Twitter / X account of the organiser ("@name"). */
  twitterSite?: string;
}

/** Canonical, hreflang, Open Graph and Twitter metadata of an indexable page. */
export function pageSeo(p: PageSeo): Metadata {
  const url = localeUrl(p.locale, p.path, p.defaultLocale);
  const images = p.image
    ? [
        {
          url: p.image.url,
          ...(p.image.width && p.image.height && { width: p.image.width, height: p.image.height }),
        },
      ]
    : undefined;
  return {
    alternates: { canonical: url, languages: languageAlternates(p.path, p.defaultLocale) },
    openGraph: {
      type: 'website',
      title: p.title,
      description: p.description,
      url,
      siteName: p.siteName,
      locale: OG_LOCALES[p.locale] ?? p.locale,
      alternateLocale: SUPPORTED_LOCALES.filter((l) => l !== p.locale).map(
        (l) => OG_LOCALES[l] ?? l,
      ),
      images,
    },
    twitter: {
      card: images ? 'summary_large_image' : 'summary',
      ...(p.twitterSite && { site: p.twitterSite }),
      title: p.title,
      description: p.description,
      images: images?.map((i) => i.url),
    },
  };
}
