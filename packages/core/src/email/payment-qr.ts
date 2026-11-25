import { bankAccounts, type Executor } from '@tix/db';
import { eq } from 'drizzle-orm';
import { mailTranslator } from '../i18n/mail-messages';
import { buildEpcPayload } from '../payments/epc-qr';
import { epcQrPng } from '../payments/qr-png';
import { escapeHtml, trustedHtml, type TrustedHtml } from './template';

/**
 * `{{paymentQrCode}}`: the EPC QR code ("GiroCode") of a bank transfer as an inline image. Mail
 * clients (Gmail) strip `data:` images, so the PNG travels as a related MIME part and the HTML
 * references it by Content-ID. Built at render time from the order and the current default bank
 * account (amount due changes between confirmation and reminder) – never stored in the outbox.
 */

/** Placeholder name in templates. */
export const PAYMENT_QR_VARIABLE = 'paymentQrCode';
/** Content-ID of the inline image (unique within one message). */
export const PAYMENT_QR_CID = 'girocode@tix.invalid';

/** Image shipped as a related MIME part and referenced from the HTML via `cid:`. */
export interface InlineImage {
  cid: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface PaymentQrInput {
  holder: string;
  /** Raw IBAN (not the grouped display form). */
  iban: string;
  bic?: string | null;
  amountCents: number;
  currency: string;
  reference: string | null | undefined;
}

/** Display size in the e-mail (the PNG itself is larger for sharp rendering on HiDPI screens). */
const DISPLAY_PX = 180;

/** HTML block for an image source (`cid:…` in mails, a data URI in the admin preview). */
export function paymentQrHtml(src: string, locale: string): TrustedHtml {
  const t = mailTranslator(locale);
  const html = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="padding:0"><img src="${escapeHtml(src)}" width="${DISPLAY_PX}" height="${DISPLAY_PX}" alt="${escapeHtml(t('paymentQr.alt'))}" style="display:block;width:${DISPLAY_PX}px;height:${DISPLAY_PX}px;border:0"></td></tr><tr><td style="padding:6px 0 0;font-size:13px;line-height:1.4;color:#52525b">${escapeHtml(t('paymentQr.caption'))}</td></tr></table>`;
  // The plain-text part already lists the bank details; a QR code cannot be shown there.
  return trustedHtml(html, '');
}

/**
 * The QR block and its image, or null when the transfer cannot be expressed as an EPC QR code
 * (no reference, not EUR, nothing due, invalid IBAN …) – the placeholder then renders empty.
 */
export function buildPaymentQr(
  input: PaymentQrInput,
  locale: string,
): { variable: TrustedHtml; image: InlineImage } | null {
  if (!input.reference) return null;
  const payload = buildEpcPayload({
    name: input.holder,
    iban: input.iban,
    bic: input.bic,
    amountCents: input.amountCents,
    currency: input.currency,
    reference: input.reference,
  });
  if (!payload) return null;
  return {
    variable: paymentQrHtml(`cid:${PAYMENT_QR_CID}`, locale),
    image: {
      cid: PAYMENT_QR_CID,
      fileName: 'girocode.png',
      contentType: 'image/png',
      bytes: epcQrPng(payload),
    },
  };
}

/** The QR code of an order's open amount, paid to the default bank-transfer account. */
export async function orderPaymentQr(
  db: Executor,
  order: {
    totalGross: number;
    amountPaid: number;
    currency: string;
    paymentReference: string | null;
  },
  locale: string,
): Promise<{ variable: TrustedHtml; image: InlineImage } | null> {
  if (!order.paymentReference) return null;
  const [bank] = await db
    .select({
      holder: bankAccounts.accountHolder,
      iban: bankAccounts.iban,
      bic: bankAccounts.bic,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.isDefaultForBankTransfer, true))
    .limit(1);
  if (!bank) return null;
  return buildPaymentQr(
    {
      holder: bank.holder,
      iban: bank.iban,
      bic: bank.bic,
      amountCents: Math.max(order.totalGross - order.amountPaid, 0),
      currency: order.currency,
      reference: order.paymentReference,
    },
    locale,
  );
}

/** Replaces `cid:` references with data URIs (admin preview iframes cannot resolve CIDs). */
export function inlineImagesAsDataUris(html: string, images: readonly InlineImage[]): string {
  let out = html;
  for (const image of images) {
    const uri = `data:${image.contentType};base64,${Buffer.from(image.bytes).toString('base64')}`;
    out = out.split(`cid:${image.cid}`).join(uri);
  }
  return out;
}
