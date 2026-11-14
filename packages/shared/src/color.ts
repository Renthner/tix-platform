/**
 * Colour maths for the shop brand colour: WCAG contrast, an automatic dark-theme variant (OKLCH:
 * lightness is raised until the colour is readable on dark surfaces, hue and chroma are kept) and
 * the automatic text colour on top of the brand colour. Pure functions, shared by the server
 * (CSS variables, e-mails, manifest) and the admin live preview.
 */

/** Minimum contrast of normal text (WCAG 2.x AA). */
export const WCAG_AA_TEXT = 4.5;

/**
 * Lightest surface of the dark theme the brand colour is used as text/icon colour on (cards,
 * popovers, muted/accent hover surfaces: `oklch(0.269 0 0)` in globals.css). Computing against
 * the lightest keeps the colour readable on all darker ones (background 0.145, card 0.205).
 */
export const DARK_SURFACE_HEX = '#262626';
/** Page background of the dark theme (`--background: oklch(0.145 0 0)` in globals.css) – browser bar colour. */
export const DARK_BACKGROUND_HEX = '#0a0a0a';
/** Page background of the light theme. */
export const LIGHT_SURFACE_HEX = '#ffffff';
/** Text colours put on top of the brand colour (whichever contrasts better). */
export const ON_BRAND_LIGHT = '#ffffff';
export const ON_BRAND_DARK = '#0a0a0a';

type Rgb = readonly [number, number, number];
type Oklch = { l: number; c: number; h: number };

const HEX6 = /^#([0-9a-fA-F]{6})/;

/** Parses `#RRGGBB` (an alpha suffix is ignored); null when invalid. */
export function parseHex(hex: string): Rgb | null {
  const m = HEX6.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  const part = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

const toLinear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return s * 255;
};

/** WCAG relative luminance (0 black … 1 white). */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1 … 21) of two colours; invalid input counts as black. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hexToOklch(hex: string): Oklch {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

/** Linear sRGB of an OKLCH colour; components outside 0…1 mean "out of gamut". */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: readonly number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** OKLCH → `#RRGGBB`; an out-of-gamut colour keeps lightness and hue and loses chroma. */
function oklchToHex(color: Oklch): string {
  let lin = oklchToLinear(color);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    lin = oklchToLinear({ ...color, c: lo });
  }
  return toHex(lin.map((v) => fromLinear(Math.min(1, Math.max(0, v)))) as unknown as Rgb);
}

/** White or near-black, whichever reads better on `background` (button text on the brand colour). */
export function foregroundOn(background: string): string {
  return contrastRatio(ON_BRAND_LIGHT, background) >= contrastRatio(ON_BRAND_DARK, background)
    ? ON_BRAND_LIGHT
    : ON_BRAND_DARK;
}

/**
 * Dark-theme variant of a brand colour: unchanged when it already reaches `minContrast` on the
 * dark surface, otherwise its OKLCH lightness is raised (hue and chroma kept, chroma only
 * reduced when sRGB cannot show it) until it does.
 */
export function darkVariant(
  hex: string,
  surface: string = DARK_SURFACE_HEX,
  minContrast: number = WCAG_AA_TEXT,
): string {
  const normalized = toHex(parseHex(hex) ?? [0, 0, 0]);
  if (contrastRatio(normalized, surface) >= minContrast) return normalized;
  const lch = hexToOklch(normalized);
  for (let l = lch.l; l <= 1.0001; l += 0.005) {
    const candidate = oklchToHex({ ...lch, l: Math.min(1, l) });
    if (contrastRatio(candidate, surface) >= minContrast) return candidate;
  }
  return '#FFFFFF';
}

export interface BrandTheme {
  /** The colour used on the page (text, buttons, rings). */
  primary: string;
  /** Text / icon colour on top of `primary`. */
  foreground: string;
  /** Contrast of `primary` as text on the theme's page surface. */
  textContrast: number;
}

export interface BrandTokens {
  light: BrandTheme;
  dark: BrandTheme;
  /** True when the dark colour was computed (no override). */
  darkComputed: boolean;
  /** Light colour readable as text on white (≥ AA)? */
  lightTextOk: boolean;
}

/** All colours derived from the brand colour (and the optional dark override). */
export function brandTokens(brand: string, darkOverride?: string | null): BrandTokens {
  const light = toHex(parseHex(brand) ?? [17, 24, 39]);
  const override = darkOverride && parseHex(darkOverride) ? toHex(parseHex(darkOverride)!) : null;
  const dark = override ?? darkVariant(light);
  const lightText = contrastRatio(light, LIGHT_SURFACE_HEX);
  return {
    light: { primary: light, foreground: foregroundOn(light), textContrast: lightText },
    dark: {
      primary: dark,
      foreground: foregroundOn(dark),
      textContrast: contrastRatio(dark, DARK_SURFACE_HEX),
    },
    darkComputed: !override,
    lightTextOk: lightText >= WCAG_AA_TEXT,
  };
}
