import { isValidIban, normalizeIban } from '@tix/shared';
import qrcode from 'qrcode-generator';

/**
 * EPC QR code ("GiroCode", EPC069-12 version 002): scanned by banking apps to pre-fill a SEPA
 * credit transfer. Pure functions, no I/O.
 */

export interface EpcQrInput {
  /** Beneficiary name (cut to 70 characters). */
  name: string;
  iban: string;
  /** Optional with version 002 inside the EEA. */
  bic?: string | null;
  /** Amount in cents (> 0). */
  amountCents: number;
  /** Only EUR is defined by the standard. */
  currency?: string;
  /** Unstructured remittance information (cut to 140 characters). */
  reference: string;
}

const MAX_NAME = 70;
const MAX_REFERENCE = 140;
/** 999 999 999.99 EUR – the standard's upper limit. */
const MAX_AMOUNT_CENTS = 99_999_999_999;
/** The standard allows 331 bytes in total. */
const MAX_PAYLOAD_BYTES = 331;

const clean = (value: string, max: number) =>
  [...value.replace(/[\r\n\t]+/g, ' ').trim()].slice(0, max).join('');

/** "12.34" – cents without floating point arithmetic. */
export function epcAmount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Payload text of the QR code, or null when the data cannot be expressed (invalid IBAN, amount
 * not a positive whole number of cents / too large, currency other than EUR, empty name or
 * reference, payload above 331 UTF-8 bytes).
 */
export function buildEpcPayload(input: EpcQrInput): string | null {
  const currency = (input.currency ?? 'EUR').toUpperCase();
  if (currency !== 'EUR') return null;
  if (!Number.isSafeInteger(input.amountCents)) return null;
  if (input.amountCents < 1 || input.amountCents > MAX_AMOUNT_CENTS) return null;
  if (!isValidIban(input.iban)) return null;
  const name = clean(input.name, MAX_NAME);
  if (!name) return null;
  const reference = clean(input.reference, MAX_REFERENCE);
  if (!reference) return null;
  const bic = input.bic ? input.bic.replace(/\s+/g, '').toUpperCase() : '';
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) return null;
  const elements = [
    'BCD',
    '002',
    '1', // UTF-8
    'SCT',
    bic,
    name,
    normalizeIban(input.iban),
    `EUR${epcAmount(input.amountCents)}`,
    '', // purpose code
    '', // structured remittance reference (we use the unstructured text)
    reference,
    '', // beneficiary-to-originator information
  ];
  // EPC069-12: nothing may follow the last populated element (trailing lines are omitted).
  while (elements.at(-1) === '') elements.pop();
  const payload = elements.join('\n');
  return epcQrBytes(payload).length <= MAX_PAYLOAD_BYTES ? payload : null;
}

/** The bytes the QR code carries: the payload as UTF-8 (character set "1" of the payload). */
export function epcQrBytes(payload: string): Uint8Array {
  return new TextEncoder().encode(payload);
}

/**
 * The payload as the "binary string" handed to qrcode-generator: one character per UTF-8 byte.
 * The library's byte mode converts strings with `charCode & 0xff` (Latin-1 – an umlaut would end up
 * as a single, wrong byte), and its ESM build has no UTF-8 converter to switch to; pre-encoding
 * keeps the encoding local instead of patching the library's global `stringToBytes`.
 */
export function epcQrData(payload: string): string {
  let data = '';
  for (const byte of epcQrBytes(payload)) data += String.fromCharCode(byte);
  return data;
}

/** Standalone SVG of the QR code (error correction M as required, quiet zone 4 modules). */
export function epcQrSvg(payload: string): string {
  const code = qrcode(0, 'M');
  code.addData(epcQrData(payload), 'Byte');
  code.make();
  const count = code.getModuleCount();
  const margin = 4;
  let path = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (code.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const size = count + 2 * margin;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
