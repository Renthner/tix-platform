import { createHash, createSign } from 'node:crypto';
import { events, tickets } from '@tix/db';
import { SUPPORTED_LOCALES, isBlankText, isPublicMediaKind, type Translations } from '@tix/shared';
import { eq } from 'drizzle-orm';
import { DomainError, type CoreContext } from '../context';
import { documentLocale, mailTranslator } from '../i18n/mail-messages';
import { eventTags, invalidateShopCache } from '../cache/shop-cache';
import { getMediaAsset } from '../media';
import { getSecretSetting, getSetting } from '../settings';
import type { WalletCheckIssue } from './apple';
import {
  loadWalletTicketData,
  resolveWalletDesign,
  walletPlaceLabel,
  assertTicketNotOfTestOrder,
  walletTestOrderError,
  type ResolvedWalletDesign,
  type WalletTicketData,
} from './data';

/**
 * Google Wallet: one `EventTicketClass` per event and one `EventTicketObject` per ticket are
 * created / updated through the Wallet Objects REST API (service account, scope
 * `wallet_object.issuer`). The customer link is a short "Save to Google Wallet" JWT that only
 * references the object id (RS256, signed with the same service account key), so it never hits
 * the ~1800 character URL limit.
 */

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleWalletConfig {
  issuerId: string;
  classPrefix: string;
  organizationName: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export class GoogleWalletApiError extends Error {
  override name = 'GoogleWalletApiError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Parses a service-account key file; throws a readable error when unusable. */
export function parseServiceAccountJson(json: string): {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The service account key is not valid JSON.');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.client_email !== 'string' || typeof o.private_key !== 'string') {
    throw new Error('The service account key lacks "client_email" or "private_key".');
  }
  const tokenUri =
    typeof o.token_uri === 'string' && o.token_uri.startsWith('https://')
      ? o.token_uri
      : DEFAULT_TOKEN_URI;
  return { clientEmail: o.client_email, privateKey: o.private_key, tokenUri };
}

/** Configuration when enabled and complete, else null (callers then offer no Google pass). */
export async function loadGoogleWalletConfig(ctx: CoreContext): Promise<GoogleWalletConfig | null> {
  const settings = await getSetting(ctx, 'wallet.google');
  if (!settings.enabled || !settings.issuerId || !ctx.secrets) return null;
  const secret = await getSecretSetting(ctx, 'wallet.google.credentials');
  if (!secret) return null;
  try {
    const account = parseServiceAccountJson(secret.serviceAccountJson);
    const general = await getSetting(ctx, 'general');
    return {
      issuerId: settings.issuerId,
      classPrefix: settings.classPrefix,
      organizationName: general.shopName,
      ...account,
    };
  } catch {
    return null;
  }
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** RS256 JWT (compact serialisation). */
export function signJwt(claims: Record<string, unknown>, privateKeyPem: string): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(signature)}`;
}

const tokenCache = new Map<string, { token: string; expires: number }>();

/** OAuth access token (JWT bearer grant), cached until shortly before expiry. */
export async function getGoogleAccessToken(
  config: GoogleWalletConfig,
  doFetch: FetchLike = fetch,
): Promise<string> {
  const hit = tokenCache.get(config.clientEmail);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    { iss: config.clientEmail, scope: SCOPE, aud: config.tokenUri, iat: now, exp: now + 3600 },
    config.privateKey,
  );
  const res = await doFetch(config.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new GoogleWalletApiError(
      `Google token request failed: ${json.error_description ?? json.error ?? res.status}`,
      res.status,
    );
  }
  tokenCache.set(config.clientEmail, {
    token: json.access_token,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

async function api(
  config: GoogleWalletConfig,
  doFetch: FetchLike,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const token = await getGoogleAccessToken(config, doFetch);
  const res = await doFetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function errorMessage(json: unknown, status: number): string {
  const message = (json as { error?: { message?: string } })?.error?.message;
  return `Google Wallet API error ${status}${message ? `: ${message}` : ''}`;
}

/** Insert; on conflict (already exists) patch. 404 on patch/insert surface as errors. */
async function upsert(
  config: GoogleWalletConfig,
  doFetch: FetchLike,
  resource: 'eventTicketClass' | 'eventTicketObject',
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const created = await api(config, doFetch, 'POST', `/${resource}`, body);
  if (created.status >= 200 && created.status < 300) return;
  if (created.status !== 409) {
    throw new GoogleWalletApiError(errorMessage(created.json, created.status), created.status);
  }
  const patched = await api(
    config,
    doFetch,
    'PATCH',
    `/${resource}/${encodeURIComponent(id)}`,
    body,
  );
  if (patched.status < 200 || patched.status >= 300) {
    throw new GoogleWalletApiError(errorMessage(patched.json, patched.status), patched.status);
  }
}

/** True when every field of `wanted` is present with the same value in `actual` (extras allowed). */
export function isSubset(wanted: unknown, actual: unknown): boolean {
  if (Array.isArray(wanted)) {
    return (
      Array.isArray(actual) &&
      actual.length === wanted.length &&
      wanted.every((w, i) => isSubset(w, actual[i]))
    );
  }
  if (wanted && typeof wanted === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(wanted).every(([k, v]) =>
      isSubset(v, (actual as Record<string, unknown>)[k]),
    );
  }
  return wanted === actual;
}

/**
 * Creates the class, or updates it only when the stored class differs. Google requires
 * `reviewStatus` on every insert / patch and demands `UNDER_REVIEW` (it flips the class to
 * `APPROVED` itself and echoes that on GET, so the stored value must never be sent back).
 */
export async function ensureClass(
  config: GoogleWalletConfig,
  doFetch: FetchLike,
  classId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const existing = await api(
    config,
    doFetch,
    'GET',
    `/eventTicketClass/${encodeURIComponent(classId)}`,
  );
  if (existing.status === 404) {
    await upsert(config, doFetch, 'eventTicketClass', classId, body);
    return;
  }
  if (existing.status < 200 || existing.status >= 300) {
    throw new GoogleWalletApiError(errorMessage(existing.json, existing.status), existing.status);
  }
  const { reviewStatus: _ignored, ...relevant } = body;
  if (isSubset(relevant, existing.json)) return;
  const patched = await api(
    config,
    doFetch,
    'PATCH',
    `/eventTicketClass/${encodeURIComponent(classId)}`,
    body,
  );
  if (patched.status < 200 || patched.status >= 300) {
    throw new GoogleWalletApiError(errorMessage(patched.json, patched.status), patched.status);
  }
}

export const googleClassId = (config: GoogleWalletConfig, eventId: string) =>
  `${config.issuerId}.${config.classPrefix}_${eventId}`;
export const googleObjectId = (config: GoogleWalletConfig, ticketId: string) =>
  `${config.issuerId}.${config.classPrefix}_${ticketId}`;

const localized = (language: string, value: string) => ({ defaultValue: { language, value } });

/** Like `localized`, plus `translatedValues` from content translations (non-blank ones only). */
function translatedText(
  language: string,
  value: string,
  translations: Translations | undefined,
  field: string,
) {
  const base = documentLocale(language);
  const translatedValues = SUPPORTED_LOCALES.filter((l) => l !== base).flatMap((l) => {
    const text = translations?.[l]?.[field];
    return text && !isBlankText(text) ? [{ language: l, value: text }] : [];
  });
  return {
    defaultValue: { language, value },
    ...(translatedValues.length ? { translatedValues } : {}),
  };
}

/**
 * Label with `defaultValue` in `language` and `translatedValues` for every other app locale, taken
 * from the `mail` catalogue. Without custom labels Google shows its own literal translation of
 * "Row" ("Zeile" in German).
 */
function localizedLabel(language: string, key: string) {
  const base = documentLocale(language);
  return {
    defaultValue: { language: base, value: mailTranslator(base)(key) },
    translatedValues: SUPPORTED_LOCALES.filter((l) => l !== base).map((l) => ({
      language: l,
      value: mailTranslator(l)(key),
    })),
  };
}

/** ISO 8601 local date-time with the UTC offset of `timeZone` at that instant. */
export function isoWithOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const offset = get('timeZoneName').replace('GMT', '').replace('−', '-') || '+00:00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset === '' ? '+00:00' : offset}`;
}

/** Public https URL of a public-kind media asset (Google fetches images itself), else null. */
export async function publicMediaUri(
  ctx: CoreContext,
  assetId: string | null | undefined,
): Promise<string | null> {
  if (!assetId || !ctx.appUrl) return null;
  let url: URL;
  try {
    url = new URL(ctx.appUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return null;
  }
  const asset = await getMediaAsset(ctx, assetId);
  if (!asset || !isPublicMediaKind(asset.kind)) return null;
  return `${ctx.appUrl}/api/media/${asset.id}`;
}

export interface GoogleImages {
  logo: string | null;
  hero: string | null;
}

/** `EventTicketClass` of an event (see Wallet Objects REST reference). */
export function buildGoogleClass(
  config: GoogleWalletConfig,
  data: WalletTicketData,
  design: ResolvedWalletDesign,
  images: GoogleImages,
  language: string,
): Record<string, unknown> {
  const dateTime: Record<string, string> = { start: isoWithOffset(data.startsAt, data.timeZone) };
  if (data.endsAt) dateTime.end = isoWithOffset(data.endsAt, data.timeZone);
  if (data.doorsOpenAt) dateTime.doorsOpen = isoWithOffset(data.doorsOpenAt, data.timeZone);
  return {
    id: googleClassId(config, data.eventId),
    issuerName: config.organizationName.slice(0, 100),
    // Required on insert and patch; Google promotes the class to APPROVED itself.
    reviewStatus: 'UNDER_REVIEW',
    eventName: translatedText(
      language,
      data.classTexts?.eventTitle ?? data.eventTitle,
      data.classTexts?.eventTranslations,
      'title',
    ),
    venue: {
      name: translatedText(
        language,
        data.classTexts?.venueName ?? data.venueName,
        data.classTexts?.venueTranslations,
        'name',
      ),
      address: localized(language, data.venueAddress ?? data.venueName),
    },
    dateTime,
    customSectionLabel: localizedLabel(language, 'wallet.block'),
    customRowLabel: localizedLabel(language, 'wallet.row'),
    customSeatLabel: localizedLabel(language, 'wallet.seat'),
    customGateLabel: localizedLabel(language, 'ticket.entrance'),
    hexBackgroundColor: design.backgroundColor,
    ...(images.logo ? { logo: { sourceUri: { uri: images.logo } } } : {}),
    ...(images.hero ? { heroImage: { sourceUri: { uri: images.hero } } } : {}),
    ...(data.latitude !== null && data.longitude !== null
      ? { locations: [{ latitude: data.latitude, longitude: data.longitude }] }
      : {}),
  };
}

/** `EventTicketObject` of a ticket (QR = the signed ticket payload). */
export function buildGoogleObject(
  config: GoogleWalletConfig,
  data: WalletTicketData,
): Record<string, unknown> {
  const t = mailTranslator(data.locale);
  const lang = data.locale;
  const seatInfo: Record<string, unknown> = {};
  if (data.kind === 'SEAT' && data.seat) {
    if (data.block) seatInfo.section = localized(lang, data.block);
    if (data.row) seatInfo.row = localized(lang, data.row);
    seatInfo.seat = localized(lang, data.seat);
  } else {
    seatInfo.section = localized(lang, walletPlaceLabel(data, t));
  }
  return {
    id: googleObjectId(config, data.ticketId),
    classId: data.googleWalletClassId ?? googleClassId(config, data.eventId),
    state: 'ACTIVE',
    barcode: { type: 'QR_CODE', value: data.qrPayload, alternateText: data.ticketCode },
    ticketNumber: data.ticketCode,
    ...(data.attendeeName ? { ticketHolderName: data.attendeeName } : {}),
    ticketType: localized(lang, data.categoryName),
    seatInfo,
    textModulesData: [
      { id: 'tariff', header: t('wallet.tariff'), body: data.ticketTypeName },
      { id: 'order', header: t('wallet.order'), body: data.orderNumber },
    ],
  };
}

/** Short "Save to Google Wallet" URL referencing an existing object by id. */
export function buildSaveUrl(
  config: GoogleWalletConfig,
  objectId: string,
  origin: string | null,
  now = Math.floor(Date.now() / 1000),
): string {
  const jwt = signJwt(
    {
      iss: config.clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: now,
      ...(origin ? { origins: [origin] } : {}),
      payload: { eventTicketObjects: [{ id: objectId }] },
    },
    config.privateKey,
  );
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

const synced = new Map<string, string>();
const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

/**
 * Creates / updates class and object for the ticket and returns the save URL.
 * `doFetch` is injectable for tests.
 */
export async function ensureGoogleSaveUrl(
  ctx: CoreContext,
  ticketId: string,
  doFetch: FetchLike = fetch,
): Promise<string> {
  await assertTicketNotOfTestOrder(ctx.db, ticketId);
  const config = await loadGoogleWalletConfig(ctx);
  if (!config) throw new DomainError('WALLET_DISABLED', 'Google Wallet is not available', 404);
  const [data] = await loadWalletTicketData(ctx.db, { ticketId });
  if (!data) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  if (data.isTest) throw walletTestOrderError();
  const general = await getSetting(ctx, 'general');
  const design = await resolveWalletDesign(ctx, data.eventId);
  const branding = await getSetting(ctx, 'branding');
  const images: GoogleImages = {
    logo: await publicMediaUri(ctx, branding.logoAssetId),
    hero: await publicMediaUri(ctx, data.heroImageAssetId),
  };

  const classBody = buildGoogleClass(config, data, design, images, general.defaultLocale);
  const classId = classBody.id as string;
  const classHash = sha(classBody);
  if (synced.get(classId) !== classHash) {
    await ensureClass(config, doFetch, classId, classBody);
    synced.set(classId, classHash);
  }
  if (data.googleWalletClassId !== classId) {
    await ctx.db
      .update(events)
      .set({ googleWalletClassId: classId })
      .where(eq(events.id, data.eventId));
    data.googleWalletClassId = classId;
    await invalidateShopCache(ctx, eventTags(data.eventId));
  }

  const objectBody = buildGoogleObject(config, data);
  const objectId = objectBody.id as string;
  const objectHash = sha(objectBody);
  if (synced.get(objectId) !== objectHash) {
    await upsert(config, doFetch, 'eventTicketObject', objectId, objectBody);
    synced.set(objectId, objectHash);
  }
  await ctx.db
    .update(tickets)
    .set({ googleWalletObjectId: objectId })
    .where(eq(tickets.id, ticketId));

  let origin: string | null = null;
  try {
    origin = ctx.appUrl ? new URL(ctx.appUrl).origin : null;
  } catch {
    origin = null;
  }
  return buildSaveUrl(config, objectId, origin);
}

export interface GoogleConfigCheck {
  ok: boolean;
  errors: WalletCheckIssue[];
  warnings: WalletCheckIssue[];
  serviceAccount?: string;
}

/** Admin "check configuration": obtains a token and lists one class of the issuer. */
export async function checkGoogleWalletConfiguration(
  ctx: CoreContext,
  doFetch: FetchLike = fetch,
): Promise<GoogleConfigCheck> {
  const result: GoogleConfigCheck = { ok: false, errors: [], warnings: [] };
  const settings = await getSetting(ctx, 'wallet.google');
  if (!settings.issuerId) result.errors.push({ code: 'issuerMissing' });
  const secret = ctx.secrets ? await getSecretSetting(ctx, 'wallet.google.credentials') : null;
  if (!secret) {
    result.errors.push({ code: 'serviceAccountMissing' });
    return result;
  }
  let account;
  try {
    account = parseServiceAccountJson(secret.serviceAccountJson);
    createSign('RSA-SHA256').update('x').sign(account.privateKey);
  } catch (err) {
    result.errors.push(
      err instanceof Error && !/PEM|key|DECODER/i.test(err.message)
        ? { code: 'serviceAccountInvalid', detail: err.message }
        : { code: 'privateKeyUnusable' },
    );
    return result;
  }
  result.serviceAccount = account.clientEmail;
  if (!settings.issuerId) return result;
  const config: GoogleWalletConfig = {
    issuerId: settings.issuerId,
    classPrefix: settings.classPrefix,
    organizationName: '',
    ...account,
  };
  try {
    await getGoogleAccessToken(config, doFetch);
  } catch (err) {
    result.errors.push({
      code: 'tokenFailed',
      ...(err instanceof Error ? { detail: err.message } : {}),
    });
    return result;
  }
  try {
    const res = await api(
      config,
      doFetch,
      'GET',
      `/eventTicketClass?issuerId=${encodeURIComponent(settings.issuerId)}&maxResults=1`,
    );
    if (res.status === 401 || res.status === 403) {
      result.errors.push({ code: 'issuerNoAccess', params: { issuerId: settings.issuerId } });
    } else if (res.status < 200 || res.status >= 300) {
      result.errors.push({ code: 'apiError', detail: errorMessage(res.json, res.status) });
    }
  } catch (err) {
    result.errors.push({
      code: 'requestFailed',
      ...(err instanceof Error ? { detail: err.message } : {}),
    });
  }
  if (!ctx.appUrl?.startsWith('https://')) {
    result.warnings.push({ code: 'appUrlNotHttps' });
  }
  result.ok = result.errors.length === 0;
  return result;
}
