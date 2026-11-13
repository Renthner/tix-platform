import { events } from '@tix/db';
import { SUPPORTED_LOCALES } from '@tix/shared';
import type { MetadataRoute } from 'next';
import { getCore } from '@/server/core';
import { languageAlternates, loadContentLocale, localeUrl } from '@/server/seo';
import { shopOrderBy, shopVisibleCondition } from '@/server/shop-events';

// Needs the database: never evaluate at build time.
export const dynamic = 'force-dynamic';

/** Search engines read at most 50 000 URLs per sitemap; each event contributes one per locale. */
const MAX_EVENTS = Math.floor(50_000 / SUPPORTED_LOCALES.length) - 10;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const core = getCore();
  const { defaultLocale } = await loadContentLocale('');
  const rows = await core.db
    .select({ slug: events.slug, updatedAt: events.updatedAt })
    .from(events)
    .where(shopVisibleCondition())
    .orderBy(...shopOrderBy())
    .limit(MAX_EVENTS);
  const entry = (path: string, lastModified?: Date): MetadataRoute.Sitemap =>
    SUPPORTED_LOCALES.map((locale) => ({
      url: localeUrl(locale, path, defaultLocale),
      ...(lastModified && { lastModified }),
      alternates: { languages: languageAlternates(path, defaultLocale) },
    }));
  return [
    ...entry('/'),
    ...entry('/cookies'),
    ...rows.flatMap((e) => entry(`/events/${e.slug}`, e.updatedAt)),
  ];
}
