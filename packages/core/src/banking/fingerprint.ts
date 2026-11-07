import { createHash } from 'node:crypto';
import type { ParsedTransaction } from './types';

/**
 * Duplicate detection across sources: the same booking may arrive via FinTS, a camt upload,
 * a mailed MT940 file and a CSV export. The fingerprint therefore only uses fields every
 * format carries in the same way – booking date, signed amount, currency, counterparty IBAN
 * and the first 80 letters/digits of the remittance text (formats differ in line wrapping,
 * spacing and case) – plus an occurrence index for identical bookings within one batch.
 * Bank-side references are deliberately excluded (they differ between camt and MT940).
 */

const REMITTANCE_CHARS = 80;

export function normalizeForFingerprint(value: string | null | undefined): string {
  return (value ?? '')
    .toUpperCase()
    .replace(/Ä/g, 'AE')
    .replace(/Ö/g, 'OE')
    .replace(/Ü/g, 'UE')
    .replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, REMITTANCE_CHARS);
}

export function fingerprintBase(tx: ParsedTransaction): string {
  return [
    tx.bookingDate,
    String(tx.amount),
    tx.currency.toUpperCase(),
    (tx.counterpartyIban ?? '').replace(/\s/g, '').toUpperCase(),
    normalizeForFingerprint(tx.remittanceInformation),
  ].join('|');
}

/** Fingerprints for a batch (same order); identical bookings get increasing occurrence indices. */
export function fingerprintBatch(transactions: readonly ParsedTransaction[]): string[] {
  const seen = new Map<string, number>();
  return transactions.map((tx) => {
    const base = fingerprintBase(tx);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return createHash('sha256').update(`v1|${base}|${occurrence}`).digest('hex');
  });
}
