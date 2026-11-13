import { getMediaAsset, getSetting } from '@tix/core';
import { normalizeLocale } from '@tix/shared';
import type { MetadataRoute } from 'next';
import { getTranslations } from 'next-intl/server';
import { getCore } from '@/server/core';
import { loadContentLocale } from '@/server/seo';

// Branding is edited in the admin: never evaluate at build time.
export const dynamic = 'force-dynamic';

type Icon = NonNullable<MetadataRoute.Manifest['icons']>[number];

/** Icon entry for a configured media asset; `sizes` only when the dimensions are known. */
async function mediaIcon(id: string | undefined): Promise<Icon | null> {
  if (!id) return null;
  const asset = await getMediaAsset(getCore(), id);
  if (!asset) return null;
  const sizes =
    asset.mimeType === 'image/svg+xml'
      ? 'any'
      : asset.width && asset.height
        ? `${asset.width}x${asset.height}`
        : undefined;
  return { src: `/api/media/${id}`, type: asset.mimeType, ...(sizes && { sizes }) };
}

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const core = getCore();
  const [general, branding, { defaultLocale }] = await Promise.all([
    getSetting(core, 'general'),
    getSetting(core, 'branding'),
    loadContentLocale(''),
  ]);
  const t = await getTranslations({ locale: normalizeLocale(defaultLocale), namespace: 'common' });
  const icons = (
    await Promise.all([mediaIcon(branding.faviconAssetId), mediaIcon(branding.logoAssetId)])
  ).filter((i): i is Icon => i !== null);
  return {
    name: general.shopName,
    short_name:
      general.shopName.length > 12 ? general.shopName.slice(0, 12).trimEnd() : general.shopName,
    description: t('meta.description'),
    lang: defaultLocale,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: branding.primaryColor,
    icons: icons.length > 0 ? icons : [{ src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' }],
  };
}
