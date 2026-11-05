'use client';

import { useSyncExternalStore } from 'react';
import type { EditorSymbol } from './types';

/**
 * Rasterised SVG symbols for the Konva canvas.
 *
 * Library markup is sanitised server-side and only ever used as an image source (never
 * injected into the DOM). Colourisable symbols use `currentColor`, resolved by wrapping the
 * markup in an `<svg color="…">`. Images are cached per (symbol, colour); subscribers are
 * notified when an image finished loading so canvas layers can redraw.
 */

/** Intrinsic raster size – large enough to stay crisp when zoomed in. */
const RASTER_SIZE = 128;

const images = new Map<string, HTMLImageElement>();
const ready = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function symbolSvg(
  symbol: Pick<EditorSymbol, 'viewBox' | 'markup' | 'colorize'>,
  color: string,
): string {
  const colorAttr = symbol.colorize ? ` color="${color}" fill="currentColor"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER_SIZE}" height="${RASTER_SIZE}"` +
    ` viewBox="${symbol.viewBox}"${colorAttr}>${symbol.markup}</svg>`
  );
}

export function symbolDataUrl(
  symbol: Pick<EditorSymbol, 'viewBox' | 'markup' | 'colorize'>,
  color: string,
): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(symbolSvg(symbol, color))}`;
}

/**
 * Loaded image for a symbol in a colour, or null while it is still loading (the caller is
 * re-rendered via `useSymbolImagesVersion` once it is available).
 */
export function getSymbolImage(symbol: EditorSymbol, color: string): HTMLImageElement | null {
  if (typeof window === 'undefined') return null;
  const key = symbol.colorize ? `${symbol.id}|${color.toLowerCase()}` : symbol.id;
  let image = images.get(key);
  if (!image) {
    image = new window.Image();
    image.decoding = 'async';
    image.onload = () => {
      ready.add(key);
      notify();
    };
    image.src = symbolDataUrl(symbol, color);
    images.set(key, image);
  }
  return ready.has(key) ? image : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever another symbol image finished loading. */
export function useSymbolImagesVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}
