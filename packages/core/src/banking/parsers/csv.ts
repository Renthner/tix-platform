import type { CsvColumnKey, CsvProfile } from '@tix/shared';
import { cleanText, parseAmountToCents, parseDate } from '../text';
import { StatementParseError, type ParsedStatementFile, type ParsedTransaction } from '../types';

/**
 * CSV account statements (German online-banking exports: semicolon separated, German number
 * and date formats, Windows-1252 or UTF-8). Columns are found by the header names configured
 * in the connection's CSV profile, otherwise by a list of common header names. Pending
 * ("vorgemerkt") rows are skipped.
 */

/** Normalised header → field. Compared after lower-casing, umlaut folding and removing punctuation. */
const SYNONYMS: Record<CsvColumnKey, string[]> = {
  bookingDate: [
    'buchungstag',
    'buchungsdatum',
    'buchung',
    'datum',
    'bookingdate',
    'date',
    'belegdatum',
  ],
  valueDate: ['valutadatum', 'valuta', 'wertstellung', 'wertstellungsdatum', 'valuedate', 'wert'],
  amount: [
    'betrag',
    'betrageur',
    'betragineur',
    'umsatz',
    'umsatzineur',
    'umsatzeur',
    'amount',
    'betragwaehrung',
  ],
  creditDebitIndicator: ['sollhaben', 'sh', 'creditdebit', 'cdindicator'],
  currency: ['waehrung', 'wahrung', 'whrung', 'currency', 'wkz', 'waehrungscode'],
  counterpartyName: [
    'namezahlungsbeteiligter',
    'beguenstigterzahlungspflichtiger',
    'zahlungspflichtigerbeguenstigter',
    'auftraggeberbeguenstigter',
    'beguenstigterauftraggeber',
    'auftraggeberempfaenger',
    'empfaengerauftraggeber',
    'zahlungsbeteiligter',
    'gegenseite',
    'name',
    'payee',
    'counterparty',
    'auftraggeber',
  ],
  counterpartyIban: [
    'ibanzahlungsbeteiligter',
    'kontonummeriban',
    'ibankontonummer',
    'gegenkontoiban',
    'iban',
    'counterpartyiban',
    'kontonummer',
  ],
  counterpartyBic: [
    'bicswiftcodezahlungsbeteiligter',
    'biczahlungsbeteiligter',
    'bicswiftcode',
    'bic',
    'swiftcode',
  ],
  remittanceInformation: [
    'verwendungszweck',
    'buchungsdetails',
    'remittanceinformation',
    'purpose',
    'reference',
    'description',
    'beschreibung',
    'vwz',
  ],
  endToEndId: [
    'kundenreferenzendtoend',
    'endtoendreferenz',
    'endtoendid',
    'endtoendreference',
    'kundenreferenz',
  ],
  bookingText: [
    'buchungstext',
    'umsatzart',
    'vorgang',
    'transaktionsart',
    'umsatztyp',
    'buchungsart',
    'art',
  ],
  status: ['status', 'umsatzstatus', 'buchungsstatus'],
};

const OWN_ACCOUNT_HEADERS = ['ibanauftragskonto', 'auftragskonto', 'kontoiban', 'eigeneskonto'];
const DEBIT_HEADERS = ['soll', 'sollbetrag', 'ausgang', 'belastung', 'debit'];
const CREDIT_HEADERS = ['haben', 'habenbetrag', 'eingang', 'gutschrift', 'credit'];

export function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

/** RFC 4180 tokenizer (quotes, doubled quotes, line breaks inside quotes). */
export function tokenizeCsv(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    if (quoted) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

export function detectDelimiter(content: string): ';' | ',' | '\t' {
  const lines = content
    .split(/\r?\n/)
    .slice(0, 30)
    .filter((l) => l.trim() !== '');
  let best: ';' | ',' | '\t' = ';';
  let bestScore = -1;
  for (const candidate of [';', '\t', ','] as const) {
    const counts = lines.map((l) => tokenizeCsv(l, candidate)[0]?.length ?? 1);
    const max = Math.max(0, ...counts);
    if (max < 2) continue;
    const consistent = counts.filter((c) => c === max).length;
    const score = consistent * 100 + max;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

interface ColumnPlan {
  index: Partial<Record<CsvColumnKey, number>>;
  remittanceColumns: number[];
  debitColumn: number | null;
  creditColumn: number | null;
  ownAccountColumn: number | null;
}

function planColumns(header: string[], profile: CsvProfile): ColumnPlan | null {
  const normalized = header.map(normalizeHeader);
  const index: Partial<Record<CsvColumnKey, number>> = {};
  const used = new Set<number>();
  const keys = Object.keys(SYNONYMS) as CsvColumnKey[];
  // Explicit mapping first.
  for (const key of keys) {
    const configured = profile.columns[key];
    if (!configured) continue;
    const at = normalized.indexOf(normalizeHeader(configured));
    if (at === -1) return null;
    index[key] = at;
    used.add(at);
  }
  for (const key of keys) {
    if (index[key] !== undefined) continue;
    for (const synonym of SYNONYMS[key]) {
      const at = normalized.findIndex((h, i) => h === synonym && !used.has(i));
      if (at !== -1) {
        index[key] = at;
        used.add(at);
        break;
      }
    }
  }
  // Several purpose columns ("Verwendungszweck 1", "Verwendungszweckzeile 2" …).
  let remittanceColumns =
    index.remittanceInformation !== undefined ? [index.remittanceInformation] : [];
  if (!profile.columns.remittanceInformation) {
    const multi = normalized
      .map((h, i) => (/^(verwendungszweck|vwz)(zeile)?\d+$/.test(h) ? i : -1))
      .filter((i) => i >= 0);
    if (multi.length > 0 && index.remittanceInformation === undefined) remittanceColumns = multi;
  }
  const find = (names: string[]) => {
    const at = normalized.findIndex((h, i) => names.includes(h) && !used.has(i));
    return at === -1 ? null : at;
  };
  const debitColumn = index.amount === undefined ? find(DEBIT_HEADERS) : null;
  const creditColumn = index.amount === undefined ? find(CREDIT_HEADERS) : null;
  if (index.bookingDate === undefined) return null;
  if (index.amount === undefined && (debitColumn === null || creditColumn === null)) return null;
  return {
    index,
    remittanceColumns,
    debitColumn,
    creditColumn,
    ownAccountColumn: find(OWN_ACCOUNT_HEADERS),
  };
}

const DEBIT_MARK = /^(s|soll|d|debit|dbit|lastschrift|belastung|-)$/i;
const CREDIT_MARK = /^(h|haben|c|credit|crdt|gutschrift|\+)$/i;
const PENDING = /vorgemerkt|pending|nicht gebucht|offen|unbooked/i;

export function parseCsv(
  content: string,
  profile: CsvProfile,
  defaultCurrency: string,
): ParsedStatementFile {
  const delimiter = profile.delimiter === 'auto' ? detectDelimiter(content) : profile.delimiter;
  const rows = tokenizeCsv(content.replace(/^﻿/, ''), delimiter);
  if (rows.length === 0) throw new StatementParseError('EMPTY_FILE', 'The CSV file is empty');

  let headerAt = -1;
  let plan: ColumnPlan | null = null;
  if (profile.headerRow !== null) {
    headerAt = profile.headerRow - 1;
    plan = rows[headerAt] ? planColumns(rows[headerAt]!, profile) : null;
  } else {
    for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
      plan = planColumns(rows[i]!, profile);
      if (plan) {
        headerAt = i;
        break;
      }
    }
  }
  if (!plan) {
    throw new StatementParseError(
      'CSV_COLUMNS',
      'Could not find the columns for booking date and amount – configure the CSV column mapping',
    );
  }

  const header = rows[headerAt]!;
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];
  let pending = 0;
  let ownAccount: string | null = null;
  const cell = (row: string[], key: CsvColumnKey) => {
    const at = plan!.index[key];
    return at === undefined ? '' : (row[at] ?? '');
  };

  for (let r = headerAt + 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    if (row.every((c) => c === '')) continue;
    const dateRaw = cell(row, 'bookingDate');
    const amountRaw =
      plan.index.amount !== undefined
        ? cell(row, 'amount')
        : (row[plan.debitColumn!] ?? '') || (row[plan.creditColumn!] ?? '');
    if (!dateRaw && !amountRaw) continue;
    if (PENDING.test(cell(row, 'status'))) {
      pending += 1;
      continue;
    }
    const bookingDate = parseDate(dateRaw, profile.dateFormat);
    if (!bookingDate) {
      // Footer lines ("Kontostand", "Summe") have no date – ignore them quietly.
      if (dateRaw && /\d/.test(dateRaw)) warnings.push(`Line ${r + 1}: invalid date "${dateRaw}"`);
      continue;
    }
    let amount: number | null;
    if (plan.index.amount !== undefined) {
      amount = parseAmountToCents(amountRaw, profile.decimalSeparator);
      const mark = cell(row, 'creditDebitIndicator');
      if (amount !== null && mark) {
        if (DEBIT_MARK.test(mark)) amount = -Math.abs(amount);
        else if (CREDIT_MARK.test(mark)) amount = Math.abs(amount);
      }
    } else {
      const debit = parseAmountToCents(row[plan.debitColumn!] ?? '', profile.decimalSeparator);
      const credit = parseAmountToCents(row[plan.creditColumn!] ?? '', profile.decimalSeparator);
      amount = credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null;
    }
    if (amount === null || amount === 0) {
      warnings.push(`Line ${r + 1}: invalid amount "${amountRaw}"`);
      continue;
    }
    if (ownAccount === null && plan.ownAccountColumn !== null) {
      ownAccount = row[plan.ownAccountColumn] || null;
    }
    const remittance = plan.remittanceColumns
      .map((i) => row[i] ?? '')
      .filter(Boolean)
      .join(plan.remittanceColumns.length > 1 ? '' : ' ');
    const iban = cell(row, 'counterpartyIban').replace(/\s/g, '').toUpperCase();
    const currency = cell(row, 'currency').toUpperCase();
    const e2e = cell(row, 'endToEndId');
    const extras: Record<string, string> = { source: 'csv' };
    header.forEach((name, i) => {
      if (row[i] && !Object.values(plan!.index).includes(i) && !plan!.remittanceColumns.includes(i))
        extras[name.slice(0, 60)] = row[i]!.slice(0, 500);
    });
    transactions.push({
      bookingDate,
      valueDate: parseDate(cell(row, 'valueDate'), profile.dateFormat),
      amount,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : defaultCurrency,
      counterpartyName: cleanText(cell(row, 'counterpartyName'), 140),
      counterpartyIban: /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) ? iban : null,
      counterpartyBic: cleanText(cell(row, 'counterpartyBic'), 11),
      remittanceInformation: cleanText(remittance),
      endToEndId: e2e && e2e.toUpperCase() !== 'NOTPROVIDED' ? cleanText(e2e, 35) : null,
      externalId: null,
      bankTransactionCode: null,
      bookingText: cleanText(cell(row, 'bookingText'), 200),
      raw: extras,
    });
  }
  if (pending > 0) warnings.push(`${pending} pending (not booked) rows skipped`);
  const dates = transactions.map((t) => t.bookingDate).sort();
  return {
    format: 'CSV',
    statements: [
      {
        statementId: null,
        accountIdentifier: ownAccount,
        currency: defaultCurrency,
        periodFrom: dates[0] ?? null,
        periodTo: dates.at(-1) ?? null,
        transactions,
      },
    ],
    warnings,
  };
}
