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
