import { orderAccessToken } from '../orders/access';
import { escapeHtml, trustedHtml } from '../email/template';
import type { CoreContext } from '../context';
import { mailTranslator } from '../i18n/mail-messages';
import { loadAppleWalletConfig } from './apple';
import { loadWalletTicketData, walletPlaceLabel } from './data';
import { loadGoogleWalletConfig } from './google';

export interface WalletAvailability {
  apple: boolean;
  google: boolean;
}

/** Which wallets are enabled and fully configured. Never throws. */
export async function walletAvailability(ctx: CoreContext): Promise<WalletAvailability> {
  try {
    const [apple, google] = await Promise.all([
      loadAppleWalletConfig(ctx).catch(() => null),
      loadGoogleWalletConfig(ctx).catch(() => null),
    ]);
    return { apple: Boolean(apple), google: Boolean(google) };
  } catch {
    return { apple: false, google: false };
  }
}

export type WalletKind = 'pkpass' | 'google';

/** Path of the wallet route of a ticket (`pkpass` download / `google` redirect). */
export function walletTicketPath(
  orderId: string,
  ticketId: string,
  kind: WalletKind,
  token?: string | null,
): string {
  return `/api/orders/${orderId}/tickets/${ticketId}/${kind}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
}

export interface WalletTicketLinks {
  ticketId: string;
  ticketCode: string;
  place: string;
  appleUrl?: string;
  googleUrl?: string;
}

/**
 * Wallet links of the VALID tickets of an order; empty when no wallet is available. Links are
 * absolute (`appUrl`) and carry the order access token, so they work from e-mails.
 */
export async function walletLinksForOrder(
  ctx: CoreContext,
  orderId: string,
): Promise<WalletTicketLinks[]> {
  try {
    const available = await walletAvailability(ctx);
    if (!available.apple && !available.google) return [];
    const rows = await loadWalletTicketData(ctx.db, { orderId });
    const token = orderAccessToken(ctx, orderId);
    const base = ctx.appUrl ?? '';
    return rows.map((row) => ({
      ticketId: row.ticketId,
      ticketCode: row.ticketCode,
      place: walletPlaceLabel(row, mailTranslator(row.locale)),
      ...(available.apple
        ? { appleUrl: base + walletTicketPath(orderId, row.ticketId, 'pkpass', token) }
        : {}),
      ...(available.google
        ? { googleUrl: base + walletTicketPath(orderId, row.ticketId, 'google', token) }
        : {}),
    }));
  } catch (err) {
    // A wallet problem must never block an e-mail.
    console.error('[wallet] could not build wallet links', err);
    return [];
  }
}

const BUTTON =
  'display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;margin:0 8px 8px 0';

/** `{{walletLinks}}` e-mail variable: one block of buttons per ticket (trusted HTML + text). */
export async function walletLinksVariable(ctx: CoreContext, orderId: string, locale: string) {
  const links = await walletLinksForOrder(ctx, orderId);
  if (links.length === 0 || !ctx.appUrl) return trustedHtml('', '');
  const t = mailTranslator(locale);
  const html = links
    .map((link) => {
      const buttons = [
        link.appleUrl
          ? `<a href="${escapeHtml(link.appleUrl)}" style="${BUTTON}">${escapeHtml(t('wallet.addApple'))}</a>`
          : '',
        link.googleUrl
          ? `<a href="${escapeHtml(link.googleUrl)}" style="${BUTTON}">${escapeHtml(t('wallet.addGoogle'))}</a>`
          : '',
      ].join('');
      return `<p style="margin:0 0 4px;font-size:13px;color:#52525b">${escapeHtml(link.place)} · ${escapeHtml(link.ticketCode)}</p><p style="margin:0 0 14px">${buttons}</p>`;
    })
    .join('');
  const text = links
    .map((link) =>
      [
        `${link.place} (${link.ticketCode})`,
        link.appleUrl ? `${t('wallet.addApple')}: ${link.appleUrl}` : '',
        link.googleUrl ? `${t('wallet.addGoogle')}: ${link.googleUrl}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  return trustedHtml(html, text);
}
