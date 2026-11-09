/**
 * Signed ticket QR payload (format "tix v1"). Isomorphic: parsing and verification use only
 * WebCrypto (`crypto.subtle`, Ed25519) so the same code runs in the browser, Node and – as a
 * specification – in the Kotlin scanner. The byte-exact format is documented in docs/TICKETS.md.
 *
 *   tix://v1/{keyId}.{eventId}.{ticketId}.{seatInfo}.{signature}
 *
 *  - keyId      event signing key id (`[A-Za-z0-9_-]{1,16}`), selects the verification key
 *  - eventId    UUID as base64url (no padding) of its 16 raw bytes (22 chars)
 *  - ticketId   same encoding
 *  - seatInfo   base64url (no padding) of a short UTF-8 string (may be empty)
 *  - signature  base64url (no padding) of the 64-byte Ed25519 signature over the UTF-8 bytes
 *               of everything before the LAST "." (including the "tix://v1/" prefix)
 */

export const TICKET_QR_PREFIX = 'tix://v1/';
export const TICKET_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
/** seatInfo is truncated to this many UTF-8 bytes (keeps the QR code small). */
export const TICKET_SEAT_INFO_MAX_BYTES = 80;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

// ─── base64url helpers (no Node Buffer) ─────────────────────────────────────

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Strict decoder: only the canonical unpadded alphabet is accepted. Returns null otherwise. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (!B64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
  const padded =
    text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  // Reject non-canonical trailing bits (a second spelling of the same bytes).
  return base64urlEncode(out) === text ? out : null;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const lower = uuid.toLowerCase();
  if (!UUID_PATTERN.test(lower)) throw new Error(`Invalid UUID "${uuid}"`);
  const hex = lower.replaceAll('-', '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ─── seat info ──────────────────────────────────────────────────────────────

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

export interface TicketSeatInfoInput {
  kind: 'SEAT' | 'GENERAL_ADMISSION';
  sectionLabel: string;
  rowLabel?: string | null;
  seatLabel?: string | null;
  /** Section flag `show_label_on_ticket`; when false the block name is not printed. */
  showSectionLabel: boolean;
}

/**
 * Human-readable place for the scanner: `block|row|seat` for seats (hidden/empty parts keep
 * their `|` so positions stay fixed), `GA:block` for standing areas. `|` inside labels is
 * replaced by `/`.
 */
export function ticketSeatInfo(input: TicketSeatInfoInput): string {
  const clean = (v: string | null | undefined) => (v ?? '').replaceAll('|', '/').trim();
  const block = input.showSectionLabel ? clean(input.sectionLabel) : '';
  const text =
    input.kind === 'GENERAL_ADMISSION'
      ? `GA:${block}`
      : `${block}|${clean(input.rowLabel)}|${clean(input.seatLabel)}`;
  return truncateUtf8(text, TICKET_SEAT_INFO_MAX_BYTES);
}

// ─── build / parse / verify ─────────────────────────────────────────────────

export interface TicketPayloadFields {
  keyId: string;
  eventId: string;
  ticketId: string;
  seatInfo: string;
}

/** The exact string that is signed (everything before the last "."). */
export function ticketSigningInput(fields: TicketPayloadFields): string {
  if (!TICKET_KEY_ID_PATTERN.test(fields.keyId)) throw new Error('Invalid signing key id');
  const seat = truncateUtf8(fields.seatInfo, TICKET_SEAT_INFO_MAX_BYTES);
  return (
    `${TICKET_QR_PREFIX}${fields.keyId}.` +
    `${base64urlEncode(uuidToBytes(fields.eventId))}.` +
    `${base64urlEncode(uuidToBytes(fields.ticketId))}.` +
    base64urlEncode(encoder.encode(seat))
  );
}

/** Signs the given bytes with the event's private key (server side; see `ed25519Signer`). */
export type TicketSigner = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export async function buildTicketPayload(
  fields: TicketPayloadFields,
  sign: TicketSigner,
): Promise<string> {
  const signingInput = ticketSigningInput(fields);
  const signature = await sign(encoder.encode(signingInput));
  if (signature.length !== 64) throw new Error('Ed25519 signature must be 64 bytes');
  return `${signingInput}.${base64urlEncode(signature)}`;
}

export interface ParsedTicketPayload extends TicketPayloadFields {
  /** Exact signed text (its UTF-8 bytes are the Ed25519 message). */
  signingInput: string;
  signature: Uint8Array;
}

/** Pure syntax check (no crypto). Returns null for anything that is not a tix v1 payload. */
export function parseTicketPayload(payload: string): ParsedTicketPayload | null {
  if (!payload.startsWith(TICKET_QR_PREFIX) || payload.length > 400) return null;
  const parts = payload.slice(TICKET_QR_PREFIX.length).split('.');
  if (parts.length !== 5) return null;
  const [keyId, eventB64, ticketB64, seatB64, sigB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!TICKET_KEY_ID_PATTERN.test(keyId)) return null;
  const event = base64urlDecode(eventB64);
  const ticket = base64urlDecode(ticketB64);
  const seat = base64urlDecode(seatB64);
  const signature = base64urlDecode(sigB64);
  if (event?.length !== 16 || ticket?.length !== 16 || !seat || signature?.length !== 64)
    return null;
  let seatInfo: string;
  try {
    seatInfo = strictDecoder.decode(seat);
  } catch {
    return null;
  }
  return {
    keyId,
    eventId: bytesToUuid(event),
    ticketId: bytesToUuid(ticket),
    seatInfo,
    signingInput: payload.slice(0, payload.lastIndexOf('.')),
    signature,
  };
}

/** Raw 32-byte Ed25519 public key (bytes or base64url) or null when the key is unknown. */
export type TicketPublicKey = Uint8Array | string;
export type TicketKeyResolver = (
  eventId: string,
  keyId: string,
) => TicketPublicKey | null | undefined | Promise<TicketPublicKey | null | undefined>;

export type TicketVerifyResult =
  | { ok: true; ticket: TicketPayloadFields }
  | { ok: false; reason: 'MALFORMED' | 'WRONG_EVENT' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' };

/**
 * Verifies syntax and signature using only public data – works offline in the scanner.
 * Whether the event matches the scanner's event, or the ticket is cancelled / already used,
 * is decided by the caller (the payload only proves authenticity). A revoked key must make
 * the resolver return null.
 *
 * `expectedEventId` is the event the verifier is checking in; a ticket of another event is
 * rejected as WRONG_EVENT before any key lookup. Resolvers MUST look keys up by
 * (eventId, keyId) – key ids are only unique per event.
 */
export async function verifyTicketPayload(
  payload: string,
  expectedEventId: string,
  resolveKey: TicketKeyResolver,
): Promise<TicketVerifyResult> {
  const parsed = parseTicketPayload(payload);
  if (!parsed) return { ok: false, reason: 'MALFORMED' };
  if (parsed.eventId !== expectedEventId.toLowerCase()) return { ok: false, reason: 'WRONG_EVENT' };
  const resolved = await resolveKey(parsed.eventId, parsed.keyId);
  if (!resolved) return { ok: false, reason: 'UNKNOWN_KEY' };
  const raw = typeof resolved === 'string' ? base64urlDecode(resolved) : resolved;
  if (raw?.length !== 32) return { ok: false, reason: 'UNKNOWN_KEY' };
  let valid = false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new Uint8Array(raw),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    valid = await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      new Uint8Array(parsed.signature),
      new Uint8Array(encoder.encode(parsed.signingInput)),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'BAD_SIGNATURE' };
  const { keyId, eventId, ticketId, seatInfo } = parsed;
  return { ok: true, ticket: { keyId, eventId, ticketId, seatInfo } };
}

/** Display form of a stored ticket code (`ABCDEFGHJK` → `ABCDE-FGHJK`). */
export function formatTicketCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** Normalises user input (case, spaces, dashes, Crockford aliases O->0, I/L->1) to the stored form. */
export function normalizeTicketCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replaceAll('O', '0')
    .replace(/[IL]/g, '1');
}
