import {
  EMAIL_LOGO_MAX_HEIGHT,
  EMAIL_LOGO_MAX_WIDTH,
  EMAIL_LOGO_MIMES,
  EMAIL_LOGO_MIN_HEIGHT,
  emailLogoSize,
  isPublicMediaKind,
  renderShopHeaderHtml,
  type EmailHeaderLogo,
  type EmailHeaderOptions,
} from '@tix/shared';
import type { CoreContext } from '../context';
import { getMediaAsset } from '../media';
import { trustedHtml, type TrustedHtml } from './template';

/**
 * Header band of every e-mail (`{{shopHeader}}`): the shop name, with the shop logo when one is
 * configured. Mail clients render only widely supported image formats, so the logo is used only
 * when the stored original is a PNG or JPEG (the upload pipeline normalises to those; legacy WebP /
 * anything else is omitted - the band then shows the shop name only). Display, layout and chip
 * styling come from the setting `emailHeader`; the markup itself is built by the pure
 * `renderShopHeaderHtml` of `@tix/shared` (also used by the admin preview).
 */

export { EMAIL_LOGO_MAX_HEIGHT, EMAIL_LOGO_MAX_WIDTH, EMAIL_LOGO_MIN_HEIGHT, emailLogoSize };
export type EmailLogo = EmailHeaderLogo;

/** The logo of the e-mail header, or null (no logo, no base URL, or an unsupported format). */
export async function loadEmailLogo(
  ctx: CoreContext,
  assetId: string | null | undefined,
  configuredHeight: number,
  explicitHeight?: number | null,
): Promise<EmailLogo | null> {
  if (!assetId || !ctx.appUrl) return null;
  const asset = await getMediaAsset(ctx, assetId);
  if (!asset || !isPublicMediaKind(asset.kind) || !EMAIL_LOGO_MIMES.includes(asset.mimeType)) {
    return null;
  }
  const size = emailLogoSize(configuredHeight, asset, explicitHeight);
  return { url: `${ctx.appUrl}/api/media/${asset.id}`, ...size };
}

/**
 * Inner HTML of the header cell. Without a logo this is just the escaped shop name; with one a
 * table (no flex, Outlook-safe) lays out logo and title as configured. Title-based layouts stay
 * readable when images are blocked (not `LOGO_ONLY`: the alt text carries the name there).
 */
export function buildShopHeader(params: {
  shopName: string;
  foreground: string;
  logo: EmailLogo | null;
  options?: Partial<EmailHeaderOptions>;
}): TrustedHtml {
  return trustedHtml(renderShopHeaderHtml(params), params.shopName);
}
