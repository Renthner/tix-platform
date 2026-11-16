/**
 * Header band of every e-mail (`{{shopHeader}}`): pure, dependency-free HTML builder shared by the
 * mail renderer (core) and the live preview of the admin settings card.
 *
 * The mail layout wraps the variable in a fixed table cell, so alignment and centring come from the
 * inner markup (table based, no flex, explicit sizes - Outlook safe).
 */

export const EMAIL_HEADER_LOGO_DISPLAYS = ['NONE', 'DIRECT', 'CHIP'] as const;
export type EmailHeaderLogoDisplay = (typeof EMAIL_HEADER_LOGO_DISPLAYS)[number];

export const EMAIL_HEADER_LAYOUTS = [
  'LOGO_LEFT_TITLE_RIGHT',
  'LOGO_ONLY',
  'TITLE_ONLY',
  'LOGO_ABOVE_TITLE_CENTERED',
] as const;
export type EmailHeaderLayout = (typeof EMAIL_HEADER_LAYOUTS)[number];

export const EMAIL_HEADER_ALIGNS = ['LEFT', 'CENTER'] as const;
export type EmailHeaderAlign = (typeof EMAIL_HEADER_ALIGNS)[number];

export const EMAIL_HEADER_CHIP_CORNERS = ['SQUARE', 'ROUNDED'] as const;
export type EmailHeaderChipCorners = (typeof EMAIL_HEADER_CHIP_CORNERS)[number];

export const EMAIL_HEADER_CHIP_PADDINGS = ['SMALL', 'MEDIUM'] as const;
export type EmailHeaderChipPadding = (typeof EMAIL_HEADER_CHIP_PADDINGS)[number];

/** Chip colour: strictly `#rgb` or `#rrggbb` (it ends up inside a style attribute). */
export const EMAIL_HEADER_HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Logo height range of the explicit e-mail logo height (px). */
export const EMAIL_HEADER_LOGO_HEIGHT_MIN = 16;
export const EMAIL_HEADER_LOGO_HEIGHT_MAX = 64;

/** Largest logo height when derived from the shop-header logo height (px). */
export const EMAIL_LOGO_MAX_HEIGHT = 36;
export const EMAIL_LOGO_MIN_HEIGHT = 16;
/** Widest logo (px) so a wide wordmark does not squeeze the title on phones. */
export const EMAIL_LOGO_MAX_WIDTH = 160;

const CHIP_PADDING_PX: Record<EmailHeaderChipPadding, number> = { SMALL: 4, MEDIUM: 8 };
const CHIP_RADIUS_PX = 6;

/** Mail clients render only widely supported image formats. */
export const EMAIL_LOGO_MIMES: readonly string[] = ['image/png', 'image/jpeg'];

export interface EmailHeaderOptions {
  logoDisplay: EmailHeaderLogoDisplay;
  layout: EmailHeaderLayout;
  align: EmailHeaderAlign;
  chipColor: string;
  chipCorners: EmailHeaderChipCorners;
  chipPadding: EmailHeaderChipPadding;
}

export const EMAIL_HEADER_DEFAULTS: EmailHeaderOptions = {
  logoDisplay: 'DIRECT',
  layout: 'LOGO_LEFT_TITLE_RIGHT',
  align: 'LEFT',
  chipColor: '#ffffff',
  chipCorners: 'ROUNDED',
  chipPadding: 'MEDIUM',
};

export interface EmailHeaderLogo {
  /** Absolute public URL (`/api/media/<id>`). */
  url: string;
  width: number | null;
  height: number;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/**
 * Pixel size of the logo in the mail within the width cap, keeping the aspect ratio. Without an
 * explicit height the shop-header height is used, clamped to 16-36 px; an explicit e-mail height
 * (16-64 px) wins.
 */
export function emailLogoSize(
  configuredHeight: number,
  natural: { width: number | null; height: number | null },
  explicitHeight?: number | null,
): { width: number | null; height: number } {
  let height = Math.round(
    explicitHeight != null
      ? Math.min(
          EMAIL_HEADER_LOGO_HEIGHT_MAX,
          Math.max(EMAIL_HEADER_LOGO_HEIGHT_MIN, explicitHeight),
        )
      : Math.min(EMAIL_LOGO_MAX_HEIGHT, Math.max(EMAIL_LOGO_MIN_HEIGHT, configuredHeight)),
  );
  if (!natural.width || !natural.height) return { width: null, height };
  const ratio = natural.width / natural.height;
  let width = Math.round(height * ratio);
  if (width > EMAIL_LOGO_MAX_WIDTH) {
    width = EMAIL_LOGO_MAX_WIDTH;
    height = Math.max(1, Math.round(width / ratio));
  }
  return { width: Math.max(1, width), height };
}

const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

/**
 * Inner HTML of the header cell. Without a logo (or with the logo switched off / title-only
 * layout) this is just the escaped shop name. With `LOGO_ONLY` the name is carried by the image's
 * alt text only, so it is not visible while images are blocked.
 */
export function renderShopHeaderHtml(params: {
  shopName: string;
  foreground: string;
  logo: EmailHeaderLogo | null;
  options?: Partial<EmailHeaderOptions>;
}): string {
  const o: EmailHeaderOptions = { ...EMAIL_HEADER_DEFAULTS, ...params.options };
  const name = esc(params.shopName);
  const { logo } = params;
  const showLogo = logo !== null && o.logoDisplay !== 'NONE' && o.layout !== 'TITLE_ONLY';
  const centered = o.align === 'CENTER' || o.layout === 'LOGO_ABOVE_TITLE_CENTERED';
  const center = (inner: string) =>
    `<table ${TABLE} width="100%"><tr><td align="center" style="text-align:center">${inner}</td></tr></table>`;
  const tableAttrs = centered ? `${TABLE} align="center" style="margin:0 auto"` : TABLE;
  // A nested table is not moved by `text-align` of its cell: it needs align="center" itself
  // (Gmail, Outlook) plus auto margins (everything else).
  const innerTable = centered ? tableAttrs : TABLE;

  if (!showLogo) return centered ? center(name) : name;

  const widthAttr = logo.width ? ` width="${logo.width}"` : '';
  const widthStyle = logo.width ? `width:${logo.width}px;` : '';
  const img = `<img src="${esc(logo.url)}"${widthAttr} height="${logo.height}" border="0" alt="${name}" style="display:block;border:0;outline:none;text-decoration:none;${widthStyle}${centered ? 'margin:0 auto;' : ''}">`;

  let logoBox: string;
  if (o.logoDisplay === 'CHIP') {
    const color = EMAIL_HEADER_HEX_PATTERN.test(o.chipColor)
      ? o.chipColor
      : EMAIL_HEADER_DEFAULTS.chipColor;
    const radius = o.chipCorners === 'SQUARE' ? 0 : CHIP_RADIUS_PX;
    const padding = CHIP_PADDING_PX[o.chipPadding] ?? CHIP_PADDING_PX.MEDIUM;
    logoBox = `<table ${innerTable}><tr><td bgcolor="${color}" style="background:${color};border-radius:${radius}px;padding:${padding}px">${img}</td></tr></table>`;
  } else {
    logoBox = `<table ${innerTable}><tr><td style="padding:0">${img}</td></tr></table>`;
  }

  const titleStyle = `color:${esc(params.foreground)};font-size:20px;font-weight:700;line-height:1.25`;

  if (o.layout === 'LOGO_ONLY') {
    return centered ? center(logoBox) : `<table ${TABLE}><tr><td>${logoBox}</td></tr></table>`;
  }
  if (o.layout === 'LOGO_ABOVE_TITLE_CENTERED') {
    return (
      `<table ${TABLE} width="100%">` +
      `<tr><td align="center" style="text-align:center;padding:0 0 8px 0">${logoBox}</td></tr>` +
      `<tr><td align="center" style="text-align:center;${titleStyle}">${name}</td></tr>` +
      `</table>`
    );
  }
  return (
    `<table ${tableAttrs}><tr>` +
    `<td valign="middle" style="padding:0 14px 0 0;vertical-align:middle">${logoBox}</td>` +
    `<td valign="middle" style="vertical-align:middle;${titleStyle}">${name}</td>` +
    `</tr></table>`
  );
}
