import { coreLog } from '../log';
import { escapeHtml, trustedHtml } from '../email/template';
import type { CoreContext } from '../context';
import { mailTranslator } from '../i18n/mail-messages';
import { orderAccessToken } from '../orders/access';
import { loadWalletTicketData, walletPlaceLabel } from '../wallet/data';
import { walletAvailability, walletTicketPath } from '../wallet/links';

const BUTTON =
  'display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;margin:0 8px 8px 0';

export interface TicketEmailLinks {
  ticketId: string;
  ticketCode: string;
  place: string;
  pdfUrl: string;
  appleUrl?: string;
  googleUrl?: string;
}

/** Path of the single-ticket PDF route (`token` = order access token). */
export function ticketPdfPath(orderId: string, ticketId: string, token?: string | null): string {
  return `/api/orders/${orderId}/tickets/${ticketId}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
}

/**
 * Download links (single PDF, wallet passes when available) of the VALID tickets of an order.
 * Absolute (`appUrl`), carrying the order access token. Wallet problems only drop the wallet links.
 */
export async function ticketEmailLinks(
  ctx: CoreContext,
  orderId: string,
): Promise<TicketEmailLinks[]> {
  if (!ctx.appUrl) return [];
  const rows = await loadWalletTicketData(ctx.db, { orderId });
  if (rows.length === 0) return [];
  const available = await walletAvailability(ctx);
  const token = orderAccessToken(ctx, orderId);
  const base = ctx.appUrl;
  return rows.map((row) => ({
    ticketId: row.ticketId,
    ticketCode: row.ticketCode,
    place: walletPlaceLabel(row, mailTranslator(row.locale)),
    pdfUrl: base + ticketPdfPath(orderId, row.ticketId, token),
    ...(available.apple
      ? { appleUrl: base + walletTicketPath(orderId, row.ticketId, 'pkpass', token) }
      : {}),
    ...(available.google
      ? { googleUrl: base + walletTicketPath(orderId, row.ticketId, 'google', token) }
      : {}),
  }));
}

/**
 * `{{ticketLinks}}` e-mail variable: per valid ticket a caption (place · code) and buttons for
 * the single-ticket PDF and the wallet passes (trusted HTML + text). Empty without `appUrl`
 * or valid tickets; never throws.
 */
export async function ticketLinksVariable(ctx: CoreContext, orderId: string, locale: string) {
  let links: TicketEmailLinks[];
  try {
    links = await ticketEmailLinks(ctx, orderId);
  } catch (err) {
    coreLog.error({ err }, '[tickets] could not build ticket links');
    return trustedHtml('', '');
  }
  if (links.length === 0) return trustedHtml('', '');
  const t = mailTranslator(locale);
  const button = (url: string, label: string) =>
    `<a href="${escapeHtml(url)}" style="${BUTTON}">${escapeHtml(label)}</a>`;
  const html = links
    .map((link) => {
      const buttons = [
        button(link.pdfUrl, t('wallet.downloadPdf')),
        link.appleUrl ? button(link.appleUrl, t('wallet.addApple')) : '',
        link.googleUrl ? button(link.googleUrl, t('wallet.addGoogle')) : '',
      ].join('');
      return `<p style="margin:0 0 4px;font-size:13px;color:#52525b">${escapeHtml(link.place)} · ${escapeHtml(link.ticketCode)}</p><p style="margin:0 0 14px">${buttons}</p>`;
    })
    .join('');
  const text = links
    .map((link) =>
      [
        `${link.place} (${link.ticketCode})`,
        `${t('wallet.downloadPdf')}: ${link.pdfUrl}`,
        link.appleUrl ? `${t('wallet.addApple')}: ${link.appleUrl}` : '',
        link.googleUrl ? `${t('wallet.addGoogle')}: ${link.googleUrl}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  return trustedHtml(html, text);
}
