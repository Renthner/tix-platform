import { createHash } from 'node:crypto';
import { tickets } from '@tix/db';
import { eq } from 'drizzle-orm';
import forge from 'node-forge';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { mailTranslator } from '../i18n/mail-messages';
import { loadMediaBytes } from '../media';
import { getSecretSetting, getSetting } from '../settings';
import {
  loadWalletTicketData,
  resolveWalletDesign,
  walletDoors,
  assertTicketNotOfTestOrder,
  walletTestOrderError,
  walletPlaceLabel,
  walletWhen,
  type ResolvedWalletDesign,
  type WalletTicketData,
} from './data';
import { solidPng } from './png';
import { createZip } from './zip';

/**
 * Apple Wallet (`.pkpass`): an `eventTicket` pass per ticket, signed with the admin-provided
 * Pass Type ID certificate (PKCS#7 detached signature over `manifest.json`, WWDR certificate in
 * the chain). Nothing here runs unless the wallet is enabled and its certificates are stored.
 */

export interface AppleWalletConfig {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  signerCertificatePem: string;
  signerKeyPem: string;
  signerKeyPassphrase?: string;
  wwdrCertificatePem: string;
}

/** Configuration when enabled and complete, else null (callers then offer no Apple pass). */
export async function loadAppleWalletConfig(ctx: CoreContext): Promise<AppleWalletConfig | null> {
  const settings = await getSetting(ctx, 'wallet.apple');
  if (!settings.enabled || !settings.passTypeIdentifier || !settings.teamIdentifier) return null;
  if (!ctx.secrets) return null;
  const certs = await getSecretSetting(ctx, 'wallet.apple.certificates');
  if (!certs) return null;
  const general = await getSetting(ctx, 'general');
  return {
    passTypeIdentifier: settings.passTypeIdentifier,
    teamIdentifier: settings.teamIdentifier,
    organizationName: settings.organizationName || general.shopName,
    ...certs,
  };
}

export interface ParsedAppleCertificates {
  signer: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
  wwdr: forge.pki.Certificate;
}

/** Parses the PEMs; throws `Error` with a human-readable reason when unusable. */
export function parseAppleCertificates(
  config: Pick<
    AppleWalletConfig,
    'signerCertificatePem' | 'signerKeyPem' | 'signerKeyPassphrase' | 'wwdrCertificatePem'
  >,
): ParsedAppleCertificates {
  let signer: forge.pki.Certificate;
  let wwdr: forge.pki.Certificate;
  try {
    signer = forge.pki.certificateFromPem(config.signerCertificatePem);
  } catch {
    throw new Error('The pass signing certificate is not a valid PEM certificate.');
  }
  try {
    wwdr = forge.pki.certificateFromPem(config.wwdrCertificatePem);
  } catch {
    throw new Error('The WWDR certificate is not a valid PEM certificate.');
  }
  let key: forge.pki.rsa.PrivateKey | null = null;
  try {
    const pem = config.signerKeyPem;
    if (pem.includes('ENCRYPTED')) {
      key = forge.pki.decryptRsaPrivateKey(
        pem,
        config.signerKeyPassphrase ?? '',
      ) as forge.pki.rsa.PrivateKey | null;
    } else if (config.signerKeyPassphrase && pem.includes('Proc-Type')) {
      key = forge.pki.decryptRsaPrivateKey(
        pem,
        config.signerKeyPassphrase,
      ) as forge.pki.rsa.PrivateKey | null;
    } else {
      key = forge.pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey;
    }
  } catch {
    key = null;
  }
  if (!key)
    throw new Error('The private key cannot be read (wrong passphrase or unsupported format).');
  const pub = signer.publicKey as forge.pki.rsa.PublicKey;
  if (pub.n.compareTo(key.n) !== 0 || pub.e.compareTo(key.e) !== 0) {
    throw new Error('The private key does not belong to the signing certificate.');
  }
  return { signer, key, wwdr };
}

/** Stable code + params of a configuration check finding (translated by the admin UI). */
export interface WalletCheckIssue {
  code: string;
  params?: Record<string, string | number>;
  /** Raw (English) text from a lower layer, e.g. a parser or API error. */
  detail?: string;
}

export interface AppleConfigCheck {
  ok: boolean;
  errors: WalletCheckIssue[];
  warnings: WalletCheckIssue[];
  signerSubject?: string;
  signerExpiresAt?: string;
  wwdrExpiresAt?: string;
}

const UID_OID = '0.9.2342.19200300.100.1.1';

/** Admin "check configuration": parses the stored material and reports expiry / mismatches. */
export async function checkAppleWalletConfiguration(ctx: CoreContext): Promise<AppleConfigCheck> {
  const result: AppleConfigCheck = { ok: false, errors: [], warnings: [] };
  const settings = await getSetting(ctx, 'wallet.apple');
  if (!settings.passTypeIdentifier) result.errors.push({ code: 'passTypeMissing' });
  if (!settings.teamIdentifier) result.errors.push({ code: 'teamMissing' });
  const certs = ctx.secrets ? await getSecretSetting(ctx, 'wallet.apple.certificates') : null;
  if (!certs) {
    result.errors.push({ code: 'certificatesMissing' });
    return result;
  }
  let parsed: ParsedAppleCertificates;
  try {
    parsed = parseAppleCertificates(certs);
  } catch (err) {
    result.errors.push({
      code: 'certificatesUnreadable',
      ...(err instanceof Error ? { detail: err.message } : {}),
    });
    return result;
  }
  const now = new Date();
  const check = (cert: forge.pki.Certificate, which: 'signer' | 'wwdr') => {
    const params = { cert: which };
    if (cert.validity.notAfter < now) result.errors.push({ code: 'certExpired', params });
    else if (cert.validity.notBefore > now) result.errors.push({ code: 'certNotYetValid', params });
    else if (cert.validity.notAfter.getTime() - now.getTime() < 30 * 86_400_000)
      result.warnings.push({ code: 'certExpiresSoon', params });
  };
  check(parsed.signer, 'signer');
  check(parsed.wwdr, 'wwdr');
  result.signerExpiresAt = parsed.signer.validity.notAfter.toISOString();
  result.wwdrExpiresAt = parsed.wwdr.validity.notAfter.toISOString();
  result.signerSubject = parsed.signer.subject.attributes
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${String(a.value)}`)
    .join(', ');
  const uid = parsed.signer.subject.attributes.find((a) => a.type === UID_OID)?.value;
  if (uid && settings.passTypeIdentifier && uid !== settings.passTypeIdentifier) {
    result.errors.push({
      code: 'passTypeMismatch',
      params: { actual: String(uid), expected: settings.passTypeIdentifier },
    });
  }
  try {
    if (!parsed.wwdr.isIssuer(parsed.signer) && !parsed.wwdr.verify(parsed.signer)) {
      result.warnings.push({ code: 'wwdrMismatch' });
    }
  } catch {
    result.warnings.push({ code: 'wwdrMismatch' });
  }
  result.ok = result.errors.length === 0;
  return result;
}

const rgb = (hex: string) =>
  `rgb(${Number.parseInt(hex.slice(1, 3), 16)}, ${Number.parseInt(hex.slice(3, 5), 16)}, ${Number.parseInt(hex.slice(5, 7), 16)})`;

interface PassField {
  key: string;
  label: string;
  value: string;
}

/** `pass.json` of one ticket (pure; see Apple "PassKit Package Format Reference"). */
export function buildApplePassJson(
  data: WalletTicketData,
  design: ResolvedWalletDesign,
  config: Pick<AppleWalletConfig, 'passTypeIdentifier' | 'teamIdentifier' | 'organizationName'>,
): Record<string, unknown> {
  const t = mailTranslator(data.locale);
  const doors = walletDoors(data);
  const secondary: PassField[] = [
    { key: 'date', label: t('wallet.date'), value: walletWhen(data) },
  ];
  const auxiliary: PassField[] = [];
  if (data.kind === 'SEAT' && data.seat) {
    if (data.block) auxiliary.push({ key: 'block', label: t('wallet.block'), value: data.block });
    if (data.row) auxiliary.push({ key: 'row', label: t('wallet.row'), value: data.row });
    auxiliary.push({ key: 'seat', label: t('wallet.seat'), value: data.seat });
  } else {
    auxiliary.push({
      key: 'place',
      label: t('wallet.place'),
      value: walletPlaceLabel(data, t),
    });
  }
  auxiliary.push({ key: 'category', label: t('wallet.category'), value: data.categoryName });
  if (doors) secondary.push({ key: 'doors', label: t('wallet.doors'), value: doors });

  const back: PassField[] = [
    { key: 'ticketCode', label: t('wallet.ticketCode'), value: data.ticketCode },
    { key: 'order', label: t('wallet.order'), value: data.orderNumber },
    { key: 'tariff', label: t('wallet.tariff'), value: data.ticketTypeName },
  ];
  if (data.attendeeName)
    back.push({ key: 'attendee', label: t('wallet.attendee'), value: data.attendeeName });
  const where = [data.venueName, data.venueAddress].filter(Boolean).join(', ');
  if (where) back.push({ key: 'venue', label: t('wallet.venue'), value: where });

  const pass: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeIdentifier,
    teamIdentifier: config.teamIdentifier,
    organizationName: config.organizationName,
    serialNumber: data.ticketId,
    description: design.description || data.eventTitle,
    backgroundColor: rgb(design.backgroundColor),
    foregroundColor: rgb(design.foregroundColor),
    labelColor: rgb(design.labelColor),
    relevantDate: data.startsAt.toISOString(),
    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        // The payload is pure ASCII (tix://v1/ + base64url segments).
        message: data.qrPayload,
        messageEncoding: 'iso-8859-1',
        altText: data.ticketCode,
      },
    ],
    eventTicket: {
      primaryFields: [{ key: 'event', label: t('wallet.event'), value: data.eventTitle }],
      secondaryFields: secondary,
      auxiliaryFields: auxiliary,
      backFields: back,
    },
  };
  if (design.logoText) pass.logoText = design.logoText;
  if (data.latitude !== null && data.longitude !== null) {
    pass.locations = [
      {
        latitude: data.latitude,
        longitude: data.longitude,
        relevantText: data.venueName,
      },
    ];
  }
  return pass;
}

interface PassImage {
  name: string;
  bytes: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

async function pngAsset(ctx: CoreContext, id: string | null): Promise<Uint8Array | null> {
  if (!id) return null;
  try {
    const media = await loadMediaBytes(ctx, id);
    // Apple Wallet only reads PNG; other formats are skipped (the admin form says so).
    return PNG_SIGNATURE.every((v, i) => media.bytes[i] === v) ? media.bytes : null;
  } catch {
    return null;
  }
}

async function loadPassImages(
  ctx: CoreContext,
  design: ResolvedWalletDesign,
): Promise<PassImage[]> {
  const [icon, logo, strip] = await Promise.all([
    pngAsset(ctx, design.iconAssetId),
    pngAsset(ctx, design.logoAssetId),
    pngAsset(ctx, design.stripAssetId),
  ]);
  const images: PassImage[] = [];
  // `icon.png` is mandatory; fall back to the logo, then to a neutral square.
  const iconBytes = icon ?? logo;
  if (iconBytes) {
    images.push({ name: 'icon.png', bytes: iconBytes }, { name: 'icon@2x.png', bytes: iconBytes });
  } else {
    images.push(
      { name: 'icon.png', bytes: solidPng(29, design.backgroundColor) },
      { name: 'icon@2x.png', bytes: solidPng(58, design.backgroundColor) },
      { name: 'icon@3x.png', bytes: solidPng(87, design.backgroundColor) },
    );
  }
  if (logo) images.push({ name: 'logo.png', bytes: logo }, { name: 'logo@2x.png', bytes: logo });
  if (strip)
    images.push({ name: 'strip.png', bytes: strip }, { name: 'strip@2x.png', bytes: strip });
  return images;
}

/** PKCS#7 detached signature (DER) of `manifest`. */
export function signManifest(manifest: Buffer, certs: ParsedAppleCertificates): Buffer {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString('binary'));
  p7.addCertificate(certs.signer);
  p7.addCertificate(certs.wwdr);
  p7.addSigner({
    key: certs.key,
    certificate: certs.signer,
    digestAlgorithm: forge.pki.oids.sha1 as string,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType as string, value: forge.pki.oids.data as string },
      { type: forge.pki.oids.messageDigest as string },
      { type: forge.pki.oids.signingTime as string, value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

/** Assembles and signs the `.pkpass` archive. */
export function packPkpass(
  passJson: Record<string, unknown>,
  images: readonly PassImage[],
  certs: ParsedAppleCertificates,
): Buffer {
  const files = [
    { name: 'pass.json', data: Buffer.from(JSON.stringify(passJson), 'utf8') },
    ...images.map((i) => ({ name: i.name, data: Buffer.from(i.bytes) })),
  ];
  const manifest: Record<string, string> = {};
  for (const f of files) manifest[f.name] = createHash('sha1').update(f.data).digest('hex');
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  return createZip([
    ...files,
    { name: 'manifest.json', data: manifestBytes },
    { name: 'signature', data: signManifest(manifestBytes, certs) },
  ]);
}

/** Builds the pass of one ticket from loaded data (no storage). */
export async function buildPkpassForTicket(
  ctx: CoreContext,
  data: WalletTicketData,
  config: AppleWalletConfig,
): Promise<{ bytes: Buffer; hash: string }> {
  const certs = parseAppleCertificates(config);
  const design = await resolveWalletDesign(ctx, data.eventId);
  const passJson = buildApplePassJson(data, design, config);
  const images = await loadPassImages(ctx, design);
  const hash = createHash('sha1')
    .update(JSON.stringify(passJson))
    .update(
      images.map((i) => `${i.name}:${createHash('sha1').update(i.bytes).digest('hex')}`).join('|'),
    )
    .update(certs.signer.serialNumber)
    .digest('hex')
    .slice(0, 12);
  return { bytes: packPkpass(passJson, images, certs), hash };
}

/**
 * The signed pass of a VALID ticket, generated on first request and cached in the documents
 * bucket (`tickets.pkpass_object_key`; the key carries a content hash, so a changed design,
 * certificate or ticket yields a fresh pass).
 */
export async function ensureApplePass(
  ctx: CoreContext,
  ticketId: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  await assertTicketNotOfTestOrder(ctx.db, ticketId);
  const config = await loadAppleWalletConfig(ctx);
  if (!config) throw new DomainError('WALLET_DISABLED', 'Apple Wallet is not available', 404);
  const [data] = await loadWalletTicketData(ctx.db, { ticketId });
  if (!data) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  if (data.isTest) throw walletTestOrderError();
  const storage = requireCapability(ctx, 'storage');
  const [row] = await ctx.db
    .select({ key: tickets.pkpassObjectKey })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  const fileName = `ticket-${data.ticketCode}.pkpass`;

  const built = await buildPkpassForTicket(ctx, data, config);
  const key = `wallet/${data.orderId}/${ticketId}-${built.hash}.pkpass`;
  if (row?.key === key) {
    try {
      const stored = await storage.get('documents', key);
      return { bytes: stored.body, fileName };
    } catch {
      // Missing object: fall through and store again.
    }
  }
  await storage.put('documents', key, built.bytes, 'application/vnd.apple.pkpass');
  await ctx.db.update(tickets).set({ pkpassObjectKey: key }).where(eq(tickets.id, ticketId));
  if (row?.key && row.key !== key) {
    await storage.delete('documents', row.key).catch(() => undefined);
  }
  return { bytes: built.bytes, fileName };
}
