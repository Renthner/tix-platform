import { createHash } from 'node:crypto';
import type { EmailTemplateKey } from '@tix/shared';

/**
 * Fingerprints of default e-mail templates that were shipped in the past and have since been
 * replaced by a new default. The seed upgrades a stored global template to the current
 * default only when its content still matches one of these fingerprints exactly – i.e. the
 * admin never edited it. Edited rows are never touched.
 *
 * Fingerprint = sha256(subject \0 bodyHtml \0 bodyText). When a default text changes again,
 * add the fingerprint of the text being replaced here (compute it with
 * `emailTemplateFingerprint(defaultEmailTemplates()[i])` BEFORE changing the default).
 */
export function emailTemplateFingerprint(t: {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
}): string {
  return createHash('sha256')
    .update([t.subject, t.bodyHtml, t.bodyText ?? ''].join('\0'))
    .digest('hex');
}

/** `key|locale` → fingerprints of earlier defaults. */
export const PREVIOUS_DEFAULT_FINGERPRINTS: Readonly<Record<string, readonly string[]>> = {
  // Phase 3 text: "your tickets will be sent separately" (replaced when ticket PDFs were attached).
  'PAYMENT_RECEIVED_TICKETS|en': [
    'a3ea96d72b50b218df43f00cb7e0756b6e214dd889c1f866e2dbdd3681e049fa',
    '72479c900ed00210696f32562f73f68176665ce9d4c9e789f7f5b0eeb0db34dc',
    // Phase 4 text with the single 'download all tickets' button.
    'f5b9fa79777177908fbd4d3c2d1dffd9f036c54cadc0ad98ddac1de0fff28999',
  ],
  // German: Phase 3 text, then the formal ("Sie") Phase 4 text (replaced by the informal "du" texts).
  // Every listed fingerprint upgrades directly to the current default (chained upgrade).
  'PAYMENT_RECEIVED_TICKETS|de': [
    'd5fb351b3d9e1f2553bd74044c5e59d8f8d1303e2fb90047827cede9c0db4f33',
    '2e617c02419d10e61d0f47adbeeaef9d00e8a743b914638e913130568f268096',
    '318b0a7bdb004bc18bc147219a843763b1b6d1f268dee0efc34dede820082c60',
    // Phase 4 text with the single 'download all tickets' button.
    '80b3b270fd6063189dfed5d2160e17e9b6b2aa705a1da54a4f0896f067d060c1',
  ],
  'TICKETS_RESENT|en': [
    'e091ac96bf3682ac540744c41ee880cff0257e4d4ff68cce7709bbfb4629eda8',
    'c1ed45959bda97cc0427dd9045e19ec1f38837f4ea0c282bcba176f160113979',
    // Phase 4 text with the single 'download all tickets' button.
    'f94c5779a70e5d10c45f5f893c0ceaaadbfb6c0c8bec8cfd369a317e8a759cdf',
  ],
  'TICKETS_RESENT|de': [
    '1f8832ff0265196ec717d6db3b2aba19b5716430b12fd44c764eec1c3c8ccc33',
    '739c88520219ff4374ed74aad45d721f33a5eaf24f00d0e525761b5f43725154',
    '4b5156d18376f226f2be464d0434b38e13d0f3d23e331b9003dcf1f8cb8e7e82',
    // Phase 4 text with the single 'download all tickets' button.
    '578d2251bc22d0d353d11873bce7eecb2f12e27d48016c4f8316c51951fb86c0',
  ],
  // Formal ("Sie") German defaults, replaced by the informal "du" texts.
  // Later: the two-column (label | value) bank details table, replaced by the stacked mobile layout.
  'ORDER_CONFIRMATION_BANK_TRANSFER|en': [
    '14603636517de183f1f60e36cab4fc3dd0294e50821b0e4e7346bccd07869fbc',
  ],
  'ORDER_CONFIRMATION_BANK_TRANSFER|de': [
    '304c1cd53010da128c596ac8c156f4d39976f381855d7b95ee61cfe037731c7f',
    '119723746eee8eff8db05d029ee43a82681ec017a19273b06a65e08b7e61e572',
  ],
  'PAYMENT_REMINDER|en': ['fd2f4e227a17d2f3ff7740fda08383bb997e6d7d50aede156166a65c8bcbc32f'],
  'PAYMENT_REMINDER|de': [
    '08dc1db1d49fd299ee0a89fff84e1f0cebff8e0e0223ccfc15a2a188b6f31192',
    '91714505ac78e34458ceb2c9aa9a9cadb8c83784e9d089bb63770967dfed8ec7',
  ],
  'ORDER_CANCELLED|de': ['951c6b844fb1858a25e541259bf99c54c36819ca780e573dd4030b2ced7d6a0e'],
  // Phase 4 text: one generic sentence (replaced by the PayPal / manual-transfer variants).
  'REFUND_CONFIRMATION|en': ['92a61fbef9353fe73f170c19e3fe830444bcee3f07bd23616b7559e59a197e96'],
  'REFUND_CONFIRMATION|de': [
    '1a1c5d169e5e587f3c7f7f25bc09b0f270cfd3ec34b7adf40700b2fd5c9f6226',
    'e22dc64700bbeeed9e9f9f0eab49ed36ea422596550fa817f04d8161c1ae2f77',
  ],
  'CUSTOMER_EMAIL_VERIFICATION|de': [
    'ecff97e8ab454b04c2d8758294068bd913ac967041ff52a084ef4c3d45bc7522',
  ],
  'CUSTOMER_PASSWORD_RESET|de': [
    '08b71def9e256e64790c91b5f62f2b912d0aa9ad45842e54bbcd402e1cc20178',
  ],
  'CUSTOMER_LOGIN_LINK|de': ['d20335d0dd62236ab9ad1d2c8402ad46ac32a2046fee05340e7996c4727b0859'],
  'SMTP_TEST|de': ['5a85bf983bb74cc1b298df4e53fe609f34dbbebcc56cdba936cdc9b6c9f83646'],
};

export const templateSlot = (key: EmailTemplateKey, locale: string) => `${key}|${locale}`;
