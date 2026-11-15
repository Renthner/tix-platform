import { isPublicMediaKind } from '@tix/shared';
import type { CoreContext } from '../context';
import { getMediaAsset } from '../media';
import { escapeHtml, trustedHtml, type TrustedHtml } from './template';

/**
 * Header band of every e-mail (`{{shopHeader}}`): the shop name, with the shop logo in front of
 * it when one is configured. Mail clients render only widely supported image formats, so the logo
 * is used only when the stored original is a PNG or JPEG (the upload pipeline normalises to
 * those; legacy WebP / anything else is omitted – the band then shows the shop name only, as
 * before). The logo sits on a white rounded chip so a dark or transparent logo stays readable
 * on any brand colour.
 */

/** Largest logo height inside the white chip (px); chip padding adds 2 x 6 px (about 48 px). */
export const EMAIL_LOGO_MAX_HEIGHT = 36;
export const EMAIL_LOGO_MIN_HEIGHT = 16;
/** Widest logo (px) so a wide wordmark does not squeeze the title on phones. */
export const EMAIL_LOGO_MAX_WIDTH = 160;

const EMAIL_LOGO_MIMES = new Set(['image/png', 'image/jpeg']);

export interface EmailLogo {
  /** Absolute public URL (`/api/media/<id>`). */
  url: string;
  width: number | null;
  height: number;
}

/** Pixel size of the logo in the mail: the shop-header height, clamped, within the width cap. */
export function emailLogoSize(
  configuredHeight: number,
  natural: { width: number | null; height: number | null },
): { width: number | null; height: number } {
  let height = Math.round(
    Math.min(EMAIL_LOGO_MAX_HEIGHT, Math.max(EMAIL_LOGO_MIN_HEIGHT, configuredHeight)),
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

/** The logo of the e-mail header, or null (no logo, no base URL, or an unsupported format). */
export async function loadEmailLogo(
  ctx: CoreContext,
  assetId: string | null | undefined,
  configuredHeight: number,
): Promise<EmailLogo | null> {
  if (!assetId || !ctx.appUrl) return null;
  const asset = await getMediaAsset(ctx, assetId);
  if (!asset || !isPublicMediaKind(asset.kind) || !EMAIL_LOGO_MIMES.has(asset.mimeType)) {
    return null;
  }
  const size = emailLogoSize(configuredHeight, asset);
  return { url: `${ctx.appUrl}/api/media/${asset.id}`, ...size };
}

/**
 * Inner HTML of the header cell. Without a logo this is just the escaped shop name; with one a
 * table (no flex, Outlook-safe) puts the logo chip left of the title. Text stays visible when
 * images are blocked.
 */
export function buildShopHeader(params: {
  shopName: string;
  foreground: string;
  logo: EmailLogo | null;
}): TrustedHtml {
  const name = escapeHtml(params.shopName);
  const { logo } = params;
  if (!logo) return trustedHtml(name, params.shopName);
  const widthAttr = logo.width ? ` width="${logo.width}"` : '';
  const widthStyle = logo.width ? `width:${logo.width}px;` : '';
  const img = `<img src="${escapeHtml(logo.url)}"${widthAttr} height="${logo.height}" alt="${name}" style="display:block;border:0;outline:none;text-decoration:none;${widthStyle}height:${logo.height}px;max-width:${EMAIL_LOGO_MAX_WIDTH}px">`;
  const html =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" style="padding:0 14px 0 0;vertical-align:middle"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#ffffff;border-radius:6px;padding:6px;line-height:0;font-size:0">${img}</td></tr></table></td>` +
    `<td valign="middle" style="vertical-align:middle;color:${escapeHtml(params.foreground)};font-size:20px;font-weight:700;line-height:1.25">${name}</td>` +
    `</tr></table>`;
  return trustedHtml(html, params.shopName);
}
