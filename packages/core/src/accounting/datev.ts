import { wallMs } from '../zoned-time';
import { encodeCp1252 } from './encoding';

/**
 * DATEV-Format "Buchungsstapel" (EXTF, version 700, data category 21, format version 13).
 *
 * Line 1: header record with 31 fields. Line 2: the 125 official column captions (unquoted).
 * Data records: 125 fields (booking columns filled, the rest empty). Text fields are quoted with
 * a double quote (doubled inside), numbers are not, separator semicolon, line end CRLF, Windows-1252,
 * amounts with decimal comma and without thousands separators. See docs/ACCOUNTING.md for sources.
 */

export const DATEV_FORMAT_VERSION = 13;
export const DATEV_VOUCHER_MAX = 36;
export const DATEV_TEXT_MAX = 60;
export const DATEV_DESCRIPTION_MAX = 30;

/**
 * Official column captions of Buchungsstapel format version 13 (125 columns, line 2 of the file).
 * Bookings fill the leading columns they need; all others stay empty.
 */
export const DATEV_COLUMNS = [
  'Umsatz (ohne Soll/Haben-Kz)',
  'Soll/Haben-Kennzeichen',
  'WKZ Umsatz',
  'Kurs',
  'Basisumsatz',
  'WKZ Basisumsatz',
  'Konto',
  'Gegenkonto (ohne BU-Schlüssel)',
  'BU-Schlüssel',
  'Belegdatum',
  'Belegfeld 1',
  'Belegfeld 2',
  'Skonto',
  'Buchungstext',
  'Postensperre',
  'Diverse Adressnummer',
  'Geschäftspartnerbank',
  'Sachverhalt',
  'Zinssperre',
  'Beleglink',
  'Beleginfo – Art 1',
  'Beleginfo – Inhalt 1',
  'Beleginfo – Art 2',
  'Beleginfo – Inhalt 2',
  'Beleginfo – Art 3',
  'Beleginfo – Inhalt 3',
  'Beleginfo – Art 4',
  'Beleginfo – Inhalt 4',
  'Beleginfo – Art 5',
  'Beleginfo – Inhalt 5',
  'Beleginfo – Art 6',
  'Beleginfo – Inhalt 6',
  'Beleginfo – Art 7',
  'Beleginfo – Inhalt 7',
  'Beleginfo – Art 8',
  'Beleginfo – Inhalt 8',
  'KOST1 – Kostenstelle',
  'KOST2 – Kostenstelle',
  'Kost Menge',
  'EU-Land u. USt-IdNr.',
  'EU-Steuersatz',
  'Abw. Versteuerungsart',
  'Sachverhalt L+L',
  'Funktionsergänzung L+L',
  'BU 49 Hauptfunktionstyp',
  'BU 49 Hauptfunktionsnummer',
  'BU 49 Funktionsergänzung',
  'Zusatzinformation – Art 1',
  'Zusatzinformation – Inhalt 1',
  'Zusatzinformation – Art 2',
  'Zusatzinformation – Inhalt 2',
  'Zusatzinformation – Art 3',
  'Zusatzinformation – Inhalt 3',
  'Zusatzinformation – Art 4',
  'Zusatzinformation – Inhalt 4',
  'Zusatzinformation – Art 5',
  'Zusatzinformation – Inhalt 5',
  'Zusatzinformation – Art 6',
  'Zusatzinformation – Inhalt 6',
  'Zusatzinformation – Art 7',
  'Zusatzinformation – Inhalt 7',
  'Zusatzinformation – Art 8',
  'Zusatzinformation – Inhalt 8',
  'Zusatzinformation – Art 9',
  'Zusatzinformation – Inhalt 9',
  'Zusatzinformation – Art 10',
  'Zusatzinformation – Inhalt 10',
  'Zusatzinformation – Art 11',
  'Zusatzinformation – Inhalt 11',
  'Zusatzinformation – Art 12',
  'Zusatzinformation – Inhalt 12',
  'Zusatzinformation – Art 13',
  'Zusatzinformation – Inhalt 13',
  'Zusatzinformation – Art 14',
  'Zusatzinformation – Inhalt 14',
  'Zusatzinformation – Art 15',
  'Zusatzinformation – Inhalt 15',
  'Zusatzinformation – Art 16',
  'Zusatzinformation – Inhalt 16',
  'Zusatzinformation – Art 17',
  'Zusatzinformation – Inhalt 17',
  'Zusatzinformation – Art 18',
  'Zusatzinformation – Inhalt 18',
  'Zusatzinformation – Art 19',
  'Zusatzinformation – Inhalt 19',
  'Zusatzinformation – Art 20',
  'Zusatzinformation – Inhalt 20',
  'Stück',
  'Gewicht',
  'Zahlweise',
  'Forderungsart',
  'Veranlagungsjahr',
  'Zugeordnete Fälligkeit',
  'Skontotyp',
  'Auftragsnummer',
  'Buchungstyp',
  'USt-Schlüssel (Anzahlungen)',
  'EU-Mitgliedstaat (Anzahlungen)',
  'Sachverhalt L+L (Anzahlungen)',
  'EU-Steuersatz (Anzahlungen)',
  'Erlöskonto (Anzahlungen)',
  'Herkunft-Kz',
  'Leerfeld',
  'KOST-Datum',
  'SEPA-Mandatsreferenz',
  'Skontosperre',
  'Gesellschaftername',
  'Beteiligtennummer',
  'Identifikationsnummer',
  'Zeichnernummer',
  'Postensperre bis',
  'Bezeichnung',
  'Kennzeichen',
  'Festschreibung',
  'Leistungsdatum',
  'Datum Zuord.',
  'Fälligkeit',
  'Generalumkehr',
  'Steuersatz',
  'Land',
  'Abrechnungsreferent',
  'BVV-Position',
  'EU-Mitgliedstaat u. UStID (Ursprung)',
  'EU-Steuersatz (Ursprung)',
  'Abw. Skontokonto',
] as const;
export const DATEV_COLUMN_COUNT = DATEV_COLUMNS.length;

export interface DatevHeader {
  consultantNumber: number;
  clientNumber: number;
  /** First day of the fiscal year, `YYYYMMDD`. */
  fiscalYearStart: string;
  accountLength: number;
  /** `YYYYMMDD`. */
  from: string;
  to: string;
  description: string;
  /** Chart of accounts: "03" / "04" or empty. */
  chart: '03' | '04' | '';
  createdAt: Date;
  timeZone: string;
  /** Origin code (2 characters) and exporter name – brand neutral. */
  origin?: string;
  exportedBy?: string;
}

export interface DatevBooking {
  /** Positive gross amount in cents. */
  amountCents: number;
  /** S/H relative to `account`. */
  side: 'S' | 'H';
  account: string;
  counterAccount: string;
  buKey?: string | undefined;
  /** Document date (shop time zone). */
  month: number;
  day: number;
  voucher1: string;
  text: string;
}

const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/** Amount for DATEV: comma, two decimals, no thousands separator. */
export function formatDatevAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new RangeError('DATEV amounts must be positive integers (cents)');
  }
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

/** Belegfeld 1: at most 36 characters from `A-Z a-z 0-9 $ & % * + - /`; everything else becomes "-". */
export function sanitizeVoucher(value: string): string {
  return value.replace(/[^A-Za-z0-9$&%*+\-/]/g, '-').slice(0, DATEV_VOUCHER_MAX);
}

/** Buchungstext: control characters become spaces, at most 60 characters. */
export function sanitizeBookingText(value: string): string {
  return value
    .replace(/[\p{Cc}]+/gu, ' ')
    .trim()
    .slice(0, DATEV_TEXT_MAX);
}

/** `Erzeugt am`: yyyyMMddHHmmssSSS in the given time zone. */
export function formatDatevTimestamp(date: Date, timeZone: string): string {
  const wall = new Date(wallMs(date, timeZone));
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return (
    `${wall.getUTCFullYear()}${p(wall.getUTCMonth() + 1)}${p(wall.getUTCDate())}` +
    `${p(wall.getUTCHours())}${p(wall.getUTCMinutes())}${p(wall.getUTCSeconds())}` +
    p(date.getUTCMilliseconds(), 3)
  );
}

export function datevHeaderLine(h: DatevHeader): string {
  const fields = [
    quote('EXTF'), // 1 Kennzeichen
    '700', // 2 Versionsnummer
    '21', // 3 Datenkategorie: Buchungsstapel
    quote('Buchungsstapel'), // 4 Formatname
    String(DATEV_FORMAT_VERSION), // 5 Formatversion
    formatDatevTimestamp(h.createdAt, h.timeZone), // 6 Erzeugt am
    '', // 7 Importiert
    quote((h.origin ?? 'XX').slice(0, 2)), // 8 Herkunft
    quote((h.exportedBy ?? '').slice(0, 25)), // 9 Exportiert von
    '""', // 10 Importiert von
    String(h.consultantNumber), // 11 Berater
    String(h.clientNumber), // 12 Mandant
    h.fiscalYearStart, // 13 WJ-Beginn
    String(h.accountLength), // 14 Sachkontenlänge
    h.from, // 15 Datum von
    h.to, // 16 Datum bis
    quote(h.description.slice(0, DATEV_DESCRIPTION_MAX)), // 17 Bezeichnung
    '""', // 18 Diktatkürzel
    '1', // 19 Buchungstyp: Finanzbuchführung
    '0', // 20 Rechnungslegungszweck
    '0', // 21 Festschreibung: nein
    quote('EUR'), // 22 WKZ
    '', // 23 reserviert
    '""', // 24 Derivatskennzeichen
    '', // 25 reserviert
    '', // 26 reserviert
    quote(h.chart), // 27 SKR
    '', // 28 Branchenlösungs-Id
    '', // 29 reserviert
    '""', // 30 reserviert
    '""', // 31 Anwendungsinformation
  ];
  return fields.join(';');
}

export function datevColumnLine(): string {
  return DATEV_COLUMNS.join(';');
}

export function datevBookingLine(b: DatevBooking): string {
  const fields = [
    formatDatevAmount(b.amountCents), // 1 Umsatz
    quote(b.side), // 2 Soll/Haben
    quote('EUR'), // 3 WKZ
    '', // 4 Kurs
    '', // 5 Basis-Umsatz
    '', // 6 WKZ Basis-Umsatz
    b.account, // 7 Konto
    b.counterAccount, // 8 Gegenkonto
    b.buKey ? quote(b.buKey) : '', // 9 BU-Schlüssel
    `${String(b.day).padStart(2, '0')}${String(b.month).padStart(2, '0')}`, // 10 Belegdatum DDMM
    quote(sanitizeVoucher(b.voucher1)), // 11 Belegfeld 1
    '', // 12 Belegfeld 2
    '', // 13 Skonto
    quote(sanitizeBookingText(b.text)), // 14 Buchungstext
  ];
  // Pad to the full column count of format version 13.
  while (fields.length < DATEV_COLUMN_COUNT) fields.push('');
  return fields.join(';');
}

/** Complete file: header, column header and booking rows, CRLF terminated, Windows-1252. */
export function buildDatevFile(header: DatevHeader, bookings: DatevBooking[]): Buffer {
  const lines = [datevHeaderLine(header), datevColumnLine(), ...bookings.map(datevBookingLine)];
  return encodeCp1252(`${lines.join('\r\n')}\r\n`);
}
