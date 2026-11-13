import { MEDIA_ASSET_KINDS, type MediaAssetKind } from './enums';

/**
 * Media kinds that are delivered to anyone (shop pages, e-mails, seating chart):
 * event / venue images, logos and e-mail images. Everything else – ticket backgrounds,
 * wallet images, documents, misc – is private and only served to signed-in admins
 * (the generators read the bytes server-side).
 */
export const PUBLIC_MEDIA_KINDS: readonly MediaAssetKind[] = [
  'EVENT_IMAGE',
  'VENUE_BACKGROUND',
  'LOGO',
  'EMAIL_IMAGE',
];

export function isPublicMediaKind(kind: MediaAssetKind): boolean {
  return PUBLIC_MEDIA_KINDS.includes(kind);
}

/** Where a picked image is used: `public` = delivered to anyone (shop), `private` = admin / generators only. */
export type MediaVisibility = 'public' | 'private';

/**
 * Whether an existing library asset of `kind` may be picked in a context. Public contexts accept
 * public kinds only (a private asset would otherwise become world-readable through a shop
 * field); private contexts accept any image (documents are never images to pick).
 */
export function isMediaKindAllowed(kind: MediaAssetKind, visibility: MediaVisibility): boolean {
  if (kind === 'DOCUMENT') return false;
  return visibility === 'public' ? isPublicMediaKind(kind) : true;
}

/** Kinds pickable in a context, in `MEDIA_ASSET_KINDS` order. */
export function mediaKindsFor(visibility: MediaVisibility): MediaAssetKind[] {
  return MEDIA_ASSET_KINDS.filter((k) => isMediaKindAllowed(k, visibility));
}

/** Upload limits for raster images (enforced again server-side by `uploadMediaAsset`). */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_MAX_DIMENSION = 12_000;
export const MEDIA_MAX_PIXELS = 80_000_000;
export const MEDIA_ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Responsive variants of public raster images. Every upload gets modern-format copies (AVIF,
 * WebP) at these widths (never upscaled); the stored original / master stays the PNG / JPEG
 * that PDFs, wallet passes and e-mails use. `/api/media/<id>?w=&f=` only accepts values from
 * these lists.
 */
export const MEDIA_VARIANT_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const;
export const MEDIA_VARIANT_FORMATS = ['avif', 'webp'] as const;
export type MediaVariantFormat = (typeof MEDIA_VARIANT_FORMATS)[number];

export const MEDIA_VARIANT_MIME: Record<MediaVariantFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
};

/**
 * Widths of the variants generated for a source of `sourceWidth` px: every allow-listed width
 * below the source plus the source width itself (capped at the maximum), so the full resolution
 * is available in the modern formats as well. A source narrower than the smallest width yields
 * exactly one variant at the source width.
 */
export function mediaVariantWidths(sourceWidth: number): number[] {
  const max = MEDIA_VARIANT_WIDTHS[MEDIA_VARIANT_WIDTHS.length - 1]!;
  const top = Math.min(Math.max(Math.floor(sourceWidth), 1), max);
  return [...MEDIA_VARIANT_WIDTHS.filter((w) => w < top), top];
}

/**
 * `srcset` candidates for a source: URL parameter `w` (always an allow-listed width, the server
 * picks the smallest variant that is at least that wide) and the real pixel width as descriptor.
 */
export function mediaSrcSetWidths(sourceWidth: number): { param: number; descriptor: number }[] {
  return mediaVariantWidths(sourceWidth).map((descriptor) => ({
    param: MEDIA_VARIANT_WIDTHS.find((w) => w >= descriptor) ?? descriptor,
    descriptor,
  }));
}

/**
 * Parses the `?w=&f=` query of the media route. Both come from allow-lists; `f` is required when
 * `w` is given and `w` defaults to the widest size. `null` = no variant requested (the original),
 * `'invalid'` = anything else (the route answers 400).
 */
export function parseMediaVariantQuery(
  params: URLSearchParams,
): { format: MediaVariantFormat; width: number } | null | 'invalid' {
  const f = params.get('f');
  const w = params.get('w');
  if (f === null && w === null) return null;
  const format = MEDIA_VARIANT_FORMATS.find((v) => v === f);
  if (!format) return 'invalid';
  if (w === null) return { format, width: MEDIA_VARIANT_WIDTHS[MEDIA_VARIANT_WIDTHS.length - 1]! };
  const width = MEDIA_VARIANT_WIDTHS.find((v) => String(v) === w);
  return width ? { format, width } : 'invalid';
}

/** Cache lifetime of a response that may still be replaced by a better one. */
export const MEDIA_CACHE_SHORT = 'public, max-age=300';
export const MEDIA_CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * The original under its id URL: the stored master can be replaced (one-off clean-up of legacy
 * files), so browsers revalidate (ETag) after an hour instead of caching it for a year.
 */
export const MEDIA_CACHE_ORIGINAL = 'public, max-age=3600, must-revalidate';

/**
 * `Cache-Control` of a public media response. The original revalidates (its master may be replaced
 * once). A variant is only
 * immutable when the answer to this exact request can no longer change: generation of the asset
 * has finished (`variantsProcessed`) and the chosen variant is the requested width or the widest
 * one of that format. While the worker is still converting, a request for 640 px could be
 * answered with a larger or smaller stand-in that must not stay in browser / CDN caches for a
 * year, so those answers are cached briefly only.
 */
export function publicMediaCacheControl(input: {
  /** A variant was requested via `?w=&f=`. */
  variantRequested: boolean;
  variant: { width: number; largestWidth: number } | null;
  requestedWidth: number | null;
  variantsProcessed: boolean;
}): string {
  if (!input.variantRequested) return MEDIA_CACHE_ORIGINAL;
  const { variant } = input;
  if (!variant || !input.variantsProcessed) return MEDIA_CACHE_SHORT;
  const final = variant.width === input.requestedWidth || variant.width === variant.largestWidth;
  return final ? MEDIA_CACHE_IMMUTABLE : MEDIA_CACHE_SHORT;
}
