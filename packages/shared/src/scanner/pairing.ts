/**
 * Pairing: the admin portal shows a one-time code (10 Crockford characters, entered as
 * `ABCDE-FGHJK` or scanned from a QR code) which the app exchanges for a device token.
 *
 * QR content: `tixscan://pair?v=1&u=<url-encoded server base URL>&c=<CODE>`
 */

export const SCANNER_API_VERSION = 1;
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_URI_PREFIX = 'tixscan://pair';

/** Display form `ABCDE-FGHJK`. */
export function formatPairingCode(code: string): string {
  return code.length === PAIRING_CODE_LENGTH ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** Normalises typed input (case, spaces, dashes, Crockford aliases O->0, I/L->1) to the stored form. */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replaceAll('O', '0')
    .replace(/[IL]/g, '1');
}

export function buildPairingUri(serverUrl: string, code: string): string {
  const params = new URLSearchParams({
    v: String(SCANNER_API_VERSION),
    u: serverUrl.replace(/\/+$/, ''),
    c: normalizePairingCode(code),
  });
  return `${PAIRING_URI_PREFIX}?${params.toString()}`;
}

export function parsePairingUri(text: string): { serverUrl: string; code: string } | null {
  if (!text.startsWith(`${PAIRING_URI_PREFIX}?`)) return null;
  const params = new URLSearchParams(text.slice(PAIRING_URI_PREFIX.length + 1));
  const serverUrl = params.get('u');
  const code = params.get('c');
  if (params.get('v') !== String(SCANNER_API_VERSION) || !serverUrl || !code) return null;
  const normalized = normalizePairingCode(code);
  if (normalized.length !== PAIRING_CODE_LENGTH) return null;
  return { serverUrl, code: normalized };
}
