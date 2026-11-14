import { getSetting } from '@tix/core';
import { SUPPORTED_LOCALES } from '@tix/shared';
import type { MetadataRoute } from 'next';
import { getCore } from '@/server/core';
import { publicBaseUrl } from '@/server/seo';

// Absolute URLs come from the runtime environment (APP_URL): never evaluate at build time.
export const dynamic = 'force-dynamic';

/** Private / transactional areas, bare and under every locale prefix. */
const PRIVATE = ['/admin', '/cart', '/checkout', '/account', '/orders'];

export default async function robots(): Promise<MetadataRoute.Robots> {
  // Settings → SEO: indexing off (test / demo servers) = nothing may be crawled, no sitemap.
  if (!(await getSetting(getCore(), 'seo')).indexing) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  const base = publicBaseUrl();
  const disallow = [
    '/api/',
    ...['', ...SUPPORTED_LOCALES.map((l) => `/${l}`)].flatMap((prefix) =>
      PRIVATE.map((p) => `${prefix}${p}`),
    ),
  ];
  return {
    // /api/media serves event covers and logos: crawlers need them for link previews.
    rules: [{ userAgent: '*', allow: ['/', '/api/media/'], disallow }],
    sitemap: `${base}/sitemap.xml`,
  };
}
