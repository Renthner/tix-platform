import { coreLog } from '../log';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib';
import { toFontText } from '../invoices/pdf-text';

/**
 * Bundled PDF font: Noto Sans (SIL OFL 1.1) Regular + Bold, covering Latin, Latin Extended,
 * Greek and Cyrillic (no CJK). Fonts are embedded as subsets, so a PDF only carries the glyphs
 * it actually uses. If the font files cannot be found, rendering falls back to the PDF
 * standard fonts (WinAnsi only; other characters are transliterated or replaced by "?").
 *
 * Lookup order for the font directory: `TIX_FONT_DIR`, then the paths below (source tree for
 * tests/dev, `fonts/` next to the bundled worker, the monorepo layout of the Next.js
 * standalone output).
 */

export const BUNDLED_FONT_FAMILY = 'Noto Sans';

const FILES = { regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' } as const;

function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.TIX_FONT_DIR) dirs.push(process.env.TIX_FONT_DIR);
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    dirs.push(
      path.resolve(here, '../../assets/fonts'), // packages/core/src/pdf -> packages/core/assets/fonts
      path.resolve(here, 'fonts'), // apps/worker/dist/fonts (esbuild bundle)
    );
  } catch {
    // import.meta.url is not a file URL in some bundlers; the cwd paths below still apply.
  }
  const cwd = process.cwd();
  dirs.push(
    path.resolve(cwd, 'fonts'),
    path.resolve(cwd, 'dist/fonts'),
    path.resolve(cwd, 'packages/core/assets/fonts'), // standalone server started from its root
    path.resolve(cwd, '../../packages/core/assets/fonts'), // apps/web (dev/standalone)
    path.resolve(cwd, 'assets/fonts'), // packages/core
  );
  return dirs;
}

export interface FontBytes {
  regular: Uint8Array;
  bold: Uint8Array;
}

let cached: Promise<FontBytes | null> | undefined;

/** Reads the bundled font files once per process; null if they cannot be found. */
export function loadBundledFontBytes(): Promise<FontBytes | null> {
  cached ??= (async () => {
    for (const dir of candidateDirs()) {
      try {
        const [regular, bold] = await Promise.all([
          readFile(path.join(dir, FILES.regular)),
          readFile(path.join(dir, FILES.bold)),
        ]);
        return { regular, bold };
      } catch {
        // try the next candidate
      }
    }
    coreLog.warn({}, '[pdf] bundled Noto Sans not found, falling back to PDF standard fonts');
    return null;
  })();
  return cached;
}

export interface PdfFonts {
  regular: PDFFont;
  bold: PDFFont;
  /** True when the Unicode font is embedded (false = WinAnsi standard-font fallback). */
  unicode: boolean;
}

/** Embeds (subset) Noto Sans Regular + Bold, or Helvetica if the files are unavailable. */
export async function embedPdfFonts(doc: PDFDocument): Promise<PdfFonts> {
  const bytes = await loadBundledFontBytes();
  if (bytes) {
    try {
      doc.registerFontkit(fontkit);
      // `customName` keeps the font name (and thus the output) deterministic.
      return {
        regular: await doc.embedFont(bytes.regular, { subset: true, customName: 'NotoSans' }),
        bold: await doc.embedFont(bytes.bold, { subset: true, customName: 'NotoSans-Bold' }),
        unicode: true,
      };
    } catch (error) {
      coreLog.warn(
        { err: error },
        '[pdf] embedding Noto Sans failed, falling back to standard fonts',
      );
    }
  }
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    unicode: false,
  };
}

const supportCache = new WeakMap<PDFFont, Set<number>>();

function supportedSet(font: PDFFont): Set<number> {
  let set = supportCache.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    supportCache.set(font, set);
  }
  return set;
}

/** Text that `font` can draw: real characters where available, `?` for the rest. */
export function toPdfText(input: string, font: PDFFont): string {
  const set = supportedSet(font);
  return toFontText(input, (cp) => cp === 0x0a || set.has(cp));
}
