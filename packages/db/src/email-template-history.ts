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

/** `key|locale` → fingerprints of earlier defaults (before the header-logo change). */
const EARLIER_DEFAULT_FINGERPRINTS: Readonly<Record<string, readonly string[]>> = {
  // Phase 3 text: "your tickets will be sent separately" (replaced when ticket PDFs were attached).
  'PAYMENT_RECEIVED_TICKETS|en': [
    // Before the calendar / directions block.
    '2c23775339047dbbcda95f2671dc0bb338cc9cca5899cce06a20cf36e07894b6',
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
    // Before the calendar / directions block.
    'a41ce6639d6a47634f2dc6ea5ed021f7c8670d6e223c136871084fb4ebe88247',
    'd5fb351b3d9e1f2553bd74044c5e59d8f8d1303e2fb90047827cede9c0db4f33',
    '2e617c02419d10e61d0f47adbeeaef9d00e8a743b914638e913130568f268096',
    '318b0a7bdb004bc18bc147219a843763b1b6d1f268dee0efc34dede820082c60',
    // Phase 4 text with the single 'download all tickets' button.
    '80b3b270fd6063189dfed5d2160e17e9b6b2aa705a1da54a4f0896f067d060c1',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'c3d0d8f9855aa849f7e82958e5e20e09cffa00d891e57e5ffecd21e738052d53',
  ],
  'TICKETS_RESENT|en': [
    // Before the calendar / directions block.
    '4b69036809ee25d1b44a6c09fdad365163ab52a780c06a07c8dc38c0c3fe6358',
    'e091ac96bf3682ac540744c41ee880cff0257e4d4ff68cce7709bbfb4629eda8',
    'c1ed45959bda97cc0427dd9045e19ec1f38837f4ea0c282bcba176f160113979',
    // Phase 4 text with the single 'download all tickets' button.
    'f94c5779a70e5d10c45f5f893c0ceaaadbfb6c0c8bec8cfd369a317e8a759cdf',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'faba05f152bf82245a821081c281f2bada214051f558dde0c81e650a0600e3c2',
  ],
  'TICKETS_RESENT|de': [
    // Before the calendar / directions block.
    '93d8fceeba40d781f456e3578d8d21ffeefba4f9ba18e86a4fb69141155dff8f',
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
    // Before the GiroCode ({{paymentQrCode}}) next to the bank details.
    '7d0ecd715554cd86cbfa4c07b1e3d28a160e8c06e0c504c9637a953a66e76e53',
  ],
  'ORDER_CONFIRMATION_BANK_TRANSFER|de': [
    '304c1cd53010da128c596ac8c156f4d39976f381855d7b95ee61cfe037731c7f',
    '119723746eee8eff8db05d029ee43a82681ec017a19273b06a65e08b7e61e572',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '11c8dd3f93e21aa4fe5ab9824ade3bee1afec840e847a0ca65dbb30f25c3689e',
    // Before the GiroCode ({{paymentQrCode}}) next to the bank details.
    'd94b87456931597d23692718b8f5d56ff2eca77e5b334409f719d41cc250c2f3',
  ],
  'PAYMENT_REMINDER|en': [
    'fd2f4e227a17d2f3ff7740fda08383bb997e6d7d50aede156166a65c8bcbc32f',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    'df0d781691e267d43db06047c3cc8f8984c399f5a98aa359167c462fa074e39d',
    // Before the GiroCode ({{paymentQrCode}}) next to the bank details.
    '744a82dfc67ca3cd62a629ea98876164e55fc58bb5004452cdc1426829bb9553',
  ],
  'PAYMENT_REMINDER|de': [
    '08dc1db1d49fd299ee0a89fff84e1f0cebff8e0e0223ccfc15a2a188b6f31192',
    '91714505ac78e34458ceb2c9aa9a9cadb8c83784e9d089bb63770967dfed8ec7',
    // Fixed white text on the brand colour (now {{brandForegroundColor}}).
    '9820af9e00f79f1c3daa68424bfcba1b1e3843a4794d134c34acc92a3b8587be',
    // Before the GiroCode ({{paymentQrCode}}) next to the bank details.
    '445ec25f1ec9f4912b5e928980fb10852b2f886fd913310c752eecd54bc3852b',
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
  // "({{eventDate}}, {{eventVenue}})" – now the venue part is conditional (events without venue).
  'WAITLIST_AVAILABLE|en': ['d0bfad528800a4730cfccbe2664334834a2da7bd9de7a9476347f86679be0aed'],
  'WAITLIST_AVAILABLE|de': ['1db58d521c561df7bca305ffcce2b09e2adbe6c04b9b97998c6204063f786a4e'],
  'EVENT_CANCELLED|en': ['6e80b3491de3fdfc5e3f59a740e4372039b61cad34a85aa6ea885ef6c02e115b'],
  'EVENT_CANCELLED|de': ['7b53a037f9e4bccd850245155b02594b60ca1f5b05a03320e3d5f7b73a191f97'],
  'EVENT_POSTPONED|en': ['b0a61abca6851e4ab854d49fb9da41a762ddd52f23bf291eb92ae04753f4a896'],
  'EVENT_POSTPONED|de': ['a0c383a05737de1133bfbd30b19188d25e558230eb33aa2873b9926246ea9bc8'],
  'EVENT_CANCELLED_HOLDER|en': ['7f12fe36725327cb324ba4204359bb0ca66010141dfd8eaacbaaa1ee99b78ad3'],
  'EVENT_CANCELLED_HOLDER|de': ['c5ed904d23f02da362efa9f394d29cbe37be544a5bbe11e77ab033dbcf40eb20'],
};

/**
 * Defaults shipped before the header band got the shop logo (`{{shopHeader}}` instead of
 * `{{shopName}}`), one fingerprint per template; unedited rows upgrade to the current default.
 */
const BEFORE_HEADER_LOGO: Readonly<Record<string, readonly string[]>> = {
  'ORDER_CONFIRMATION_BANK_TRANSFER|en': [
    '1cf35c8b9b08ee261c51a75cafdd5857eefc08fd264472b3f4f75b080f45089b',
  ],
  'ORDER_CONFIRMATION_BANK_TRANSFER|de': [
    '261f77cefc78666ecab85813d024fe1d77258e49e5dcd80f094222f73eea0bde',
  ],
  'PAYMENT_RECEIVED_TICKETS|en': [
    'fbfb6d3f2b5a375fef1bcbcf754647dbfb0e1dcebdbde5e27373f3877682979c',
  ],
  'PAYMENT_RECEIVED_TICKETS|de': [
    '0f516a78130215cb5e416cdb1dc8b5817853db695100c74e1ad71743586bbb9b',
  ],
  'PAYMENT_REMINDER|en': ['acb0653bce5eecc0bf6893ba9ccb9f212bd19e7b7a654bc80d4f9b9109eec755'],
  'PAYMENT_REMINDER|de': ['e9eafd819ae0936b74724a0eef88ae286440567cda90635e3e56d56c5be84f0c'],
  'ORDER_CANCELLED|en': ['4ad6afe6797350942d0c263b8457eeb42e29dc0c2a80bfcffc7e27627706442d'],
  'ORDER_CANCELLED|de': ['28e23fd6b1501296e4f6c759f2630614364fdac68100c90c2646b516bade45cc'],
  'REFUND_CONFIRMATION|en': ['5fc5180ce0f1cac8929f5b9cb70335eb9be8681e2f151286ba55bdcf2ca69e0d'],
  'REFUND_CONFIRMATION|de': ['6d76cc3a1796d62ee72612ccc3204d8885cefb0f42efc81d4d16ebe4984b1a76'],
  'ADDITIONAL_PAYMENT_REQUEST|en': [
    '3d8610a2355f8d4f6e7675e4eb2cb4b641ba442fd35204eeceb982606e81e704',
  ],
  'ADDITIONAL_PAYMENT_REQUEST|de': [
    '8eb3e970b95d9e061493caf71630d128dbadbf92a4f70002a80ea324b261206e',
  ],
  'ADDITIONAL_PAYMENT_REMINDER|en': [
    'bcf8020b0c14086da37d323cb2b8aa3ca9eed95b50df07bb4998fef3585b6556',
  ],
  'ADDITIONAL_PAYMENT_REMINDER|de': [
    '8f097bb765e57830ff2f20e8a1dfff66207eb6d847909a1bb0df5df1224c4c7e',
  ],
  'ADDITIONAL_PAYMENT_CANCELLED|en': [
    'efa0e11065b8227977ae50f649028e750637d958856706414ac597cbefc93e93',
  ],
  'ADDITIONAL_PAYMENT_CANCELLED|de': [
    'd84c13a910d987bfcaf824fa5994e93b467429aedfad1016b4e451f7fa22cc34',
  ],
  'ADDITIONAL_PAYMENT_RECEIVED|en': [
    '1b1c816c328a55a96b706f037901da5d49218eded71dd5fe479f8b0f87e6d813',
  ],
  'ADDITIONAL_PAYMENT_RECEIVED|de': [
    'fb410069237885ced297eb020e4476c13dd5381a814618ce6d2981191d0d5fce',
  ],
  'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT|en': [
    '76800a99b32aa257e7289e0fcf8e5bf17a631e8e95b3b408fcf75d3cfc741574',
  ],
  'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT|de': [
    'bcc5a23c2d1e5ebdff4941a4ba76b16d5ce230b4a2c85020c8dbf7ef80f6a774',
  ],
  'TICKETS_RESENT|en': ['5fe258ca6aee75fa84497f1a3e01fd2bc52fac3c8d009d334ff8b1818afdb8d2'],
  'TICKETS_RESENT|de': ['49ce3428fbc79a2694628fc7e55c5070b67f8ca331f688ff2e1ffad6245413d7'],
  'TICKET_TRANSFER_RECEIVED|en': [
    'e70389f9720d9868dc0d1ceb32fd946888edb5a86ba68e544c20cd83d31e34e6',
    // Before "Your ticket" for tickets without a seat (standing / admission).
    'b0f02038cf0d9a9158a984d7a75bcd46ac3805dc51d0a167d9fbd3cb1fcaa24b',
  ],
  'TICKET_TRANSFER_RECEIVED|de': [
    'ec2a33c1b8a4c7e9ca7259044a7d46d97325605812cb80c34baa58332e0193d7',
    // Before "Your ticket" for tickets without a seat (standing / admission).
    '3a2b7deda57dcd7eb97fc940de117c22e00d8f5adb410054eb5eebfd8fcd2048',
  ],
  'TICKET_TRANSFER_SENT|en': ['9ff8f827449701316fce1ce5e0de9abac936b198aa29e4088636f46ff68bbfe6'],
  'TICKET_TRANSFER_SENT|de': ['fd8143d54574659e8e1e24e6ab230ad9064594600e8a98828a051560515e5f6d'],
  'TICKET_HOLDER_UPDATED|en': [
    '0bb72f1c3812083366845f726a45fc04ab501f08f04395e0efe51b99368a6411',
    // Before "Your ticket" for tickets without a seat (standing / admission).
    'ed5b6d72a4a5c7dd1a1e9f0bf88b000a260e6bbb55f568ae0d1570e313c35e71',
  ],
  'TICKET_HOLDER_UPDATED|de': [
    'd31895a7b8c2590d1e5105e67975fdb28953d9eadc6a1e0886359c0a779f7993',
    // Before "Your ticket" for tickets without a seat (standing / admission).
    '83942a95e3ecb509c36d76f093ce0e8bc890272fbd047b8cb41a5a6c215deb24',
  ],
  'TICKET_HOLDER_CANCELLED|en': [
    '83f11985c5489128ae2ff3ac6369e9d88185ddbe4a42c025f02cb5edc9552631',
  ],
  'TICKET_HOLDER_CANCELLED|de': [
    '2422442787947730d172ea14f3e64f2f1fe08fa1b0bc97bc2cbf3f6d7f574026',
  ],
  'CUSTOMER_EMAIL_VERIFICATION|en': [
    '92d398876a2f0ba0b45b5bdee274abf30cbd7b5f77bffdb478c2158082482ecd',
  ],
  'CUSTOMER_EMAIL_VERIFICATION|de': [
    '960aa2d6cc97cc04fdf6440df4f0aff0313349f635d835801ecc2cb8c4e3660d',
  ],
  'CUSTOMER_PASSWORD_RESET|en': [
    'fc46faa21fb2b45e7417eeaabfe0fae12b70f3dcebd1d74e9becb525a2ee7dd0',
  ],
  'CUSTOMER_PASSWORD_RESET|de': [
    'f89c820056034bb225f39f6b106e7ec6810c604b950a4b951222450c98478c25',
  ],
  'CUSTOMER_LOGIN_LINK|en': ['17b13788a0295fcc16db798ff1fe34bee63c486263daf92244e1d017f7ca4b14'],
  'CUSTOMER_LOGIN_LINK|de': ['1252d01c15e2915e6c4284eaeb830e55b83d99ebce55897a27223a3d8537f069'],
  'SMTP_TEST|en': ['c627f74ffb20bca0056b5eab9704dba3e47e2555518b583beeb0ccf4742ffea0'],
  'SMTP_TEST|de': ['4dc83ebac5885654621d76e5f45a63dea3e8128a4488c410e1bcc9d4c9bddc7f'],
  'ADMIN_INVITE|en': ['b9d1d20bf6132cd37751b047be912f3f39ba8232f19e01523d39650aa27bc603'],
  'ADMIN_INVITE|de': ['2de41c09986946a70572755c629dce99d34089c2dacb3c70a788a6829692d442'],
  'ADMIN_PASSWORD_RESET|en': ['45cf622ae6728de003ae6888953e52e8ab707f157e93a6b9ed1730c274db7606'],
  'ADMIN_PASSWORD_RESET|de': ['3f1b43792d5756c9271466755d12aeb33e675980ddc2311f1ea61c58e67de4a7'],
  'ADMIN_ALERT|en': ['3d548960e4603c69f680e4c456d44479da750d7582a68cd41c278fa879e0dd30'],
  'ADMIN_ALERT|de': ['f9540c68203978e8223a9a321c2d7b8f2c9b77913ab25152fcad6d9f032ba632'],
  'ADMIN_ALERT_RESOLVED|en': ['82234775e38ebafcb1a6c65bdb1ec2cbedbafa17af08b94b49962e00ee8b2fc4'],
  'ADMIN_ALERT_RESOLVED|de': ['2cbb43c8b200c8b2a0470a3cb18fa65d160ccd6f41246625464d6500460fb6d0'],
  'WAITLIST_CONFIRM|en': ['c6165a63656cb58ac2885a2a3bd2e09c69bf8980985d2f7460386a0a076022d8'],
  'WAITLIST_CONFIRM|de': ['b496150fc3f49abfcd663ccf447288c856d28a78b2c76bd98f9e1f04fb065322'],
  'WAITLIST_AVAILABLE|en': ['3823ec4b23e8f4d58665153abe9d965489c26f3c6ebea4e34a99c5ca4276ac5e'],
  'WAITLIST_AVAILABLE|de': ['33e212a45ac9a5ee31c955433fca0a57aa3352562f3906f8153ccb5117971527'],
  'WAITLIST_REMOVED|en': ['1b1438eb6fa5220362bd9ca66ae8985e72a6ef0711c34cc8c44e6ba64e32aaab'],
  'WAITLIST_REMOVED|de': ['b385a758b40dd79db81c19b08fac215906f26abc64a19a5a78037b04ca5aafe8'],
  'ADMIN_PASSKEY_ADDED|en': ['b01b4492fe49e9336aceb721e8b9a87015def4738cdfb91be8febedb436ded7a'],
  'ADMIN_PASSKEY_ADDED|de': ['9ef9c47bc4ff130bf7bd9d26b4ac1183ce9574a4e1671046da50a04d6f96153c'],
};

/** `key|locale` → fingerprints of every earlier default. */
export const PREVIOUS_DEFAULT_FINGERPRINTS: Readonly<Record<string, readonly string[]>> = (() => {
  const merged: Record<string, string[]> = {};
  for (const source of [EARLIER_DEFAULT_FINGERPRINTS, BEFORE_HEADER_LOGO]) {
    for (const [slot, list] of Object.entries(source)) (merged[slot] ??= []).push(...list);
  }
  return merged;
})();

export const templateSlot = (key: EmailTemplateKey, locale: string) => `${key}|${locale}`;
