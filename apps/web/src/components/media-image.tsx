import { mediaSrcSetWidths } from '@tix/shared';
import type { CSSProperties } from 'react';

export interface MediaImageProps {
  assetId: string;
  alt: string;
  /**
   * Pixel size of the stored original (reserves the box, avoids layout shift, drives the srcset).
   * Null when unknown: the original is then rendered as a plain `<img>` without a srcset.
   */
  width: number | null;
  height: number | null;
  /** Rendered width of the image per breakpoint, e.g. `(min-width: 1024px) 33vw, 100vw`. Required. */
  sizes: string;
  /** `eager` + `fetchPriority="high"` for the LCP image, lazy otherwise (the default). */
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
  className?: string;
  style?: CSSProperties;
  /** Class of the wrapping `<picture>` (default `contents`: the image lays out as its parent's child). */
  pictureClassName?: string;
}

/**
 * Public media image with modern formats: `<picture>` with AVIF and WebP sources in several
 * widths and the stored original (PNG / JPEG) as the `<img>` fallback. Renders on the server
 * (no hooks); `/api/media/<id>?w=&f=` falls back to the original for assets without variants.
 * An unknown size renders the plain original (no `<picture>`, no srcset).
 */
export function MediaImage({
  assetId,
  alt,
  width,
  height,
  sizes,
  loading = 'lazy',
  fetchPriority,
  className,
  style,
  pictureClassName = 'contents',
}: MediaImageProps) {
  const base = `/api/media/${assetId}`;
  if (!width || !height) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={base}
        alt={alt}
        loading={loading}
        decoding="async"
        {...(fetchPriority ? { fetchPriority } : {})}
        className={className}
        style={style}
      />
    );
  }
  const candidates = mediaSrcSetWidths(width);
  const srcSet = (format: 'avif' | 'webp') =>
    candidates.map((c) => `${base}?w=${c.param}&f=${format} ${c.descriptor}w`).join(', ');
  return (
    <picture className={pictureClassName}>
      <source type="image/avif" srcSet={srcSet('avif')} sizes={sizes} />
      <source type="image/webp" srcSet={srcSet('webp')} sizes={sizes} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={base}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        decoding="async"
        {...(fetchPriority ? { fetchPriority } : {})}
        className={className}
        style={style}
      />
    </picture>
  );
}

export interface MediaThumbProps {
  assetId: string;
  alt: string;
  /** Allow-listed variant width to request (a single candidate: for logos / small thumbnails). */
  variantWidth: 320 | 640 | 960 | 1280 | 1920 | 2560;
  loading?: 'eager' | 'lazy';
  className?: string;
}

/**
 * Like `MediaImage` for images of unknown size that are rendered small (logo, list thumbnails):
 * one AVIF / WebP candidate of `variantWidth`, the original as fallback; the image keeps its
 * natural aspect ratio (no explicit width / height).
 */
export function MediaThumb({
  assetId,
  alt,
  variantWidth,
  loading = 'lazy',
  className,
}: MediaThumbProps) {
  const base = `/api/media/${assetId}`;
  return (
    <picture className="contents">
      <source type="image/avif" srcSet={`${base}?w=${variantWidth}&f=avif`} />
      <source type="image/webp" srcSet={`${base}?w=${variantWidth}&f=webp`} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={base} alt={alt} loading={loading} decoding="async" className={className} />
    </picture>
  );
}
