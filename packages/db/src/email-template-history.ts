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
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '037412d5148d2c74505acb801c79bb694064bff32350ad3988666657413ebc47',
  ],
  // German: Phase 3 text, then the formal ("Sie") Phase 4 text (replaced by the informal "du" texts).
  // Every listed fingerprint upgrades directly to the current default (chained upgrade).
  'PAYMENT_RECEIVED_TICKETS|de': [
    'd5fb351b3d9e1f2553bd74044c5e59d8f8d1303e2fb90047827cede9c0db4f33',
    '2e617c02419d10e61d0f47adbeeaef9d00e8a743b914638e913130568f268096',
    '318b0a7bdb004bc18bc147219a843763b1b6d1f268dee0efc34dede820082c60',
    // Phase 4 text with the single 'download all tickets' button.
    '80b3b270fd6063189dfed5d2160e17e9b6b2aa705a1da54a4f0896f067d060c1',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'c3d0d8f9855aa849f7e82958e5e20e09cffa00d891e57e5ffecd21e738052d53',
  ],
  'TICKETS_RESENT|en': [
    'e091ac96bf3682ac540744c41ee880cff0257e4d4ff68cce7709bbfb4629eda8',
    'c1ed45959bda97cc0427dd9045e19ec1f38837f4ea0c282bcba176f160113979',
    // Phase 4 text with the single 'download all tickets' button.
    'f94c5779a70e5d10c45f5f893c0ceaaadbfb6c0c8bec8cfd369a317e8a759cdf',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'faba05f152bf82245a821081c281f2bada214051f558dde0c81e650a0600e3c2',
  ],
  'TICKETS_RESENT|de': [
    '1f8832ff0265196ec717d6db3b2aba19b5716430b12fd44c764eec1c3c8ccc33',
    '739c88520219ff4374ed74aad45d721f33a5eaf24f00d0e525761b5f43725154',
    '4b5156d18376f226f2be464d0434b38e13d0f3d23e331b9003dcf1f8cb8e7e82',
    // Phase 4 text with the single 'download all tickets' button.
    '578d2251bc22d0d353d11873bce7eecb2f12e27d48016c4f8316c51951fb86c0',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '29bd494a5065f406a09a8cea1393ffd88ac614501d1f6aee5599bdde33df392d',
  ],
  // Formal ("Sie") German defaults, replaced by the informal "du" texts.
  // Later: the two-column (label | value) bank details table, replaced by the stacked mobile layout.
  'ORDER_CONFIRMATION_BANK_TRANSFER|en': [
    '14603636517de183f1f60e36cab4fc3dd0294e50821b0e4e7346bccd07869fbc',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '2becd700967b7ec50aa584de81b43b2d334c6c67323f37f42ef0822b5af876c9',
  ],
  'ORDER_CONFIRMATION_BANK_TRANSFER|de': [
    '304c1cd53010da128c596ac8c156f4d39976f381855d7b95ee61cfe037731c7f',
    '119723746eee8eff8db05d029ee43a82681ec017a19273b06a65e08b7e61e572',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '11c8dd3f93e21aa4fe5ab9824ade3bee1afec840e847a0ca65dbb30f25c3689e',
  ],
  'PAYMENT_REMINDER|en': [
    'fd2f4e227a17d2f3ff7740fda08383bb997e6d7d50aede156166a65c8bcbc32f',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'df0d781691e267d43db06047c3cc8f8984c399f5a98aa359167c462fa074e39d',
  ],
  'PAYMENT_REMINDER|de': [
    '08dc1db1d49fd299ee0a89fff84e1f0cebff8e0e0223ccfc15a2a188b6f31192',
    '91714505ac78e34458ceb2c9aa9a9cadb8c83784e9d089bb63770967dfed8ec7',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '9820af9e00f79f1c3daa68424bfcba1b1e3843a4794d134c34acc92a3b8587be',
  ],
  'ORDER_CANCELLED|de': [
    '951c6b844fb1858a25e541259bf99c54c36819ca780e573dd4030b2ced7d6a0e',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'becc96f3c30199361b1b3dbca63719d3b145eb535f9e6d4a2aae480e10e7dca1',
  ],
  // Phase 4 text: one generic sentence (replaced by the PayPal / manual-transfer variants).
  'REFUND_CONFIRMATION|en': [
    '92a61fbef9353fe73f170c19e3fe830444bcee3f07bd23616b7559e59a197e96',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '0ec3439bddf0d439a1b5b5016da31fb51d8223c73496334cdff74df4b86a3fee',
  ],
  'REFUND_CONFIRMATION|de': [
    '1a1c5d169e5e587f3c7f7f25bc09b0f270cfd3ec34b7adf40700b2fd5c9f6226',
    'e22dc64700bbeeed9e9f9f0eab49ed36ea422596550fa817f04d8161c1ae2f77',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '325fd0774a345f2b88955077e7a2530ceaeeb1b88f0a363ff78eec8bc9fae8a9',
  ],
  'CUSTOMER_EMAIL_VERIFICATION|de': [
    'ecff97e8ab454b04c2d8758294068bd913ac967041ff52a084ef4c3d45bc7522',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'f96cd43db2acf2660da13df1a23fec6e66b0e073581e90a74bfff165bda65fb6',
  ],
  'CUSTOMER_PASSWORD_RESET|de': [
    '08b71def9e256e64790c91b5f62f2b912d0aa9ad45842e54bbcd402e1cc20178',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '67e3c09ee211f0942ba2ca471412f2340409df5d2edcb8141b31384be2c85aae',
  ],
  'CUSTOMER_LOGIN_LINK|de': [
    'd20335d0dd62236ab9ad1d2c8402ad46ac32a2046fee05340e7996c4727b0859',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'f453a80ac8fd932815c7153eb74e2cb3c9ac37474b0c29fcb9d552d7456d8e5c',
  ],
  'SMTP_TEST|de': [
    '5a85bf983bb74cc1b298df4e53fe609f34dbbebcc56cdba936cdc9b6c9f83646',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '717888b930b5033ff281a4869ac27148f87e8c7e99d5b849021922cf933486bc',
  ],
  // Fixed white text on the brand colour (now {{brandForegroundColor}}).
  'ORDER_CANCELLED|en': ['ba31591a1bb9a9039ce313459021c2297d21cd0096cd84085726cbd57a42c5ae'],
  'ADDITIONAL_PAYMENT_REQUEST|en': [
    'e4d8927895dff791490eedda3328583e5ce16ad660ff73583bef226c0f28413d',
  ],
  'ADDITIONAL_PAYMENT_REQUEST|de': [
    'e2b87af1d72957466a61d6e49404d773bbb32c69bee325a2d4c653e26d78582c',
  ],
  'ADDITIONAL_PAYMENT_REMINDER|en': [
    '561f482edcd7ee7c0d282e0bbdc667a3d3669f192b335b1c0c5df014ff6cc3f7',
  ],
  'ADDITIONAL_PAYMENT_REMINDER|de': [
    '77be6a2955b266935f5a2bcbcb963775f07f278535aa2e922f3a4892c1961c69',
  ],
  'ADDITIONAL_PAYMENT_CANCELLED|en': [
    '2bcdce2be133fc0ee23b1ad1e423ce32de51730f1479aad2b40b4333b93dcd63',
  ],
  'ADDITIONAL_PAYMENT_CANCELLED|de': [
    '1fa11a85abcde1bb782eb1aaf96412d5b1d1d03227c71d29adad9dab6c8eae02',
  ],
  'ADDITIONAL_PAYMENT_RECEIVED|en': [
    '84bf3a13ac6837d05b0ec2252e55c5edb0dce573989f6a5f06810ed4a5190051',
  ],
  'ADDITIONAL_PAYMENT_RECEIVED|de': [
    'ac9b8dc6aeb9f5acd0dfb024e9cc7155b709acaa244f003f9d79b7fc072f521a',
  ],
  'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT|en': [
    'c46207af4748e9b900da615544f0436c57c5be244c99c4dbf88118dab1d2a4bd',
  ],
  'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT|de': [
    '51dd33f5103c5c16458816cf2a1196d8114a18866808f8adb7087c6c8c151b5e',
  ],
  'CUSTOMER_EMAIL_VERIFICATION|en': [
    '993af64825cf26f14e97f76df92c3a085558c014a5162c7dd514b42fc4d3dc9f',
  ],
  'CUSTOMER_PASSWORD_RESET|en': [
    'c21c86acf9cedb74d7c058e57e0bab20a05ffdf4b7575836a68ff96df3d59f7a',
  ],
  'CUSTOMER_LOGIN_LINK|en': ['161ff461f715ca310249cf779edc791b49ca90da9158635b9f4da8a88c4d779a'],
  'SMTP_TEST|en': ['10910619e9128ada1b712927fcfab41f3559ad0ec660741ba6b654c50ec29dc8'],
  'ADMIN_INVITE|en': ['478968f808c0560a6f03a69c09053218a0eadaa38923e8e81f4c659949b8bc3c'],
  'ADMIN_INVITE|de': ['254e8b32643931560fc04f6d9e358c112453f5fe7e07d89f8fbb2bd0c4ae0ecf'],
  'ADMIN_PASSWORD_RESET|en': ['561ae749c806e61da1e771978ba7904464b020db3c8459c453dc31b477a03b89'],
  'ADMIN_PASSWORD_RESET|de': ['1f96fa2bce728d09903e04a78c82f21ccaf5b32676e2522696d69f6f5d379ba3'],
};

export const templateSlot = (key: EmailTemplateKey, locale: string) => `${key}|${locale}`;
