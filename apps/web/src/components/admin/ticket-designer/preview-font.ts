'use client';

import { useEffect, useState } from 'react';

/**
 * The ticket PDF embeds the bundled Noto Sans (Regular + Bold). The designer preview loads the very
 * same files from `/api/fonts/<file>` (same origin, so `font-src 'self'` applies) so text wraps
 * exactly like in the PDF. The font is registered on first use of the designer only.
 */

const FONT_VERSION = '1';
const FACES = [
  { weight: '400', file: 'NotoSans-Regular.ttf' },
  { weight: '700', file: 'NotoSans-Bold.ttf' },
] as const;

const FALLBACK_STACK = '"Segoe UI", Helvetica, Arial, sans-serif';
/** Differs from the fallback stack on purpose: Konva re-measures text only when the value changes. */
export const PREVIEW_FONT = `"Noto Sans", ${FALLBACK_STACK}`;

let loading: Promise<boolean> | undefined;

function loadNotoSans(): Promise<boolean> {
  loading ??= (async () => {
    try {
      for (const { weight, file } of FACES) {
        const face = new FontFace('Noto Sans', `url(/api/fonts/${file}?v=${FONT_VERSION})`, {
          weight,
          style: 'normal',
          display: 'block',
        });
        document.fonts.add(face);
      }
      await Promise.all([
        document.fonts.load('400 16px "Noto Sans"'),
        document.fonts.load('700 16px "Noto Sans"'),
      ]);
      return document.fonts.check('400 16px "Noto Sans"');
    } catch {
      return false;
    }
  })();
  return loading;
}

/**
 * Font-family for the canvas texts. Starts with the fallback stack and switches to the Noto Sans
 * stack once the font files are loaded; the changed value makes Konva measure and wrap again.
 */
export function usePreviewFontFamily(): string {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadNotoSans().then((ok) => {
      if (!cancelled && ok) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready ? PREVIEW_FONT : FALLBACK_STACK;
}
