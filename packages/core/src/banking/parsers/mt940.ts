import { cleanText, isoDate, parseAmountToCents } from '../text';
import {
  StatementParseError,
  type ParsedStatement,
  type ParsedStatementFile,
  type ParsedTransaction,
} from '../types';

/**
 * SWIFT MT940 customer statements as exported by German banks (DFÜ-Abkommen format):
 *  - `:61:` statement line (value date, optional booking date, C/D/RC/RD, amount, type,
 *    references, supplementary details)
 *  - `:86:` structured information `GVC?00…?10…?20…?29…?30…?31…?32…?33…?34…?60…?63`
 *    with SEPA tags (EREF+, SVWZ+, MREF+ …) inside the purpose lines.
 * MT942 (interim, unbooked) messages are skipped.
 */

const FIELD_START = /^:(\d{2}[A-Z]?):/;
const SEPA_TAG =
  /(EREF|KREF|MREF|CRED|DEBT|SVWZ|ABWA|ABWE|IBAN|BIC|COAM|OAMT|SQTP|PURP|RCUR|FRST|OOFF)\+/g;

interface Field {
  tag: string;
  value: string;
}

export function looksLikeMt940(content: string): boolean {
  return (
    /(^|\n):20:/.test(content) && (/(^|\n):61:/.test(content) || /(^|\n):60[FM]:/.test(content))
  );
}

function splitFields(content: string): Field[][] {
  const text = content
    .replace(/\r\n?/g, '\n')
    // SWIFT envelope blocks {1:…}{2:…}{4: … -}
    .replace(/\{[1-3]:[^}]*\}/g, '')
    .replace(/\{4:\s*/g, '')
    .replace(/-\}/g, '\n-');
  const messages: Field[][] = [];
  let current: Field[] = [];
  let field: Field | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const start = FIELD_START.exec(line);
    if (start) {
      if (start[1] === '20' && current.some((f) => f.tag === '61' || f.tag === '62F')) {
        messages.push(current);
        current = [];
      }
      field = { tag: start[1]!, value: line.slice(start[0].length) };
      current.push(field);
    } else if (line === '-' || line === '') {
      if (line === '-' && current.length > 0) {
        messages.push(current);
        current = [];
      }
      field = null;
    } else if (field) {
      // Continuation: :86: wraps without separator, :61: second line = supplementary details.
      field.value += field.tag === '61' ? `\n${line}` : line;
    }
  }
  if (current.length > 0) messages.push(current);
  return messages.filter((m) => m.some((f) => f.tag === '20' || f.tag === '61'));
}

function parseBalanceCurrency(value: string): string | null {
  const m = /^[CD]\d{6}([A-Z]{3})/.exec(value);
  return m ? m[1]! : null;
}

function parseBalanceDate(value: string): string | null {
  const m = /^[CD](\d{2})(\d{2})(\d{2})/.exec(value);
  if (!m) return null;
  return isoDate(2000 + Number(m[1]), Number(m[2]), Number(m[3]));
}

interface StatementLine {
  valueDate: string;
  bookingDate: string;
  amount: number;
  transactionType: string;
  customerReference: string | null;
  bankReference: string | null;
  supplementary: string | null;
}

const LINE_61 =
  /^(\d{2})(\d{2})(\d{2})(\d{4})?(R?[CD])([A-Z])?(\d+,\d{0,2})([A-Z][A-Z0-9]{3})([^\n]*?)(?:\/\/([^\n]*))?(?:\n([\s\S]*))?$/;

function parseLine61(value: string): StatementLine | null {
  const m = LINE_61.exec(value);
  if (!m) return null;
  const vy = 2000 + Number(m[1]);
  const vm = Number(m[2]);
  const valueDate = isoDate(vy, vm, Number(m[3]));
  if (!valueDate) return null;
  let bookingDate = valueDate;
  if (m[4]) {
    const bm = Number(m[4].slice(0, 2));
    const bd = Number(m[4].slice(2));
    let by = vy;
    if (bm - vm > 6) by -= 1;
    else if (vm - bm > 6) by += 1;
    bookingDate = isoDate(by, bm, bd) ?? valueDate;
  }
  const cents = parseAmountToCents(m[7]!, ',');
  if (cents === null) return null;
  const mark = m[5]!;
  // C = credit, D = debit, RC = reversal of a credit (money leaves), RD = reversal of a debit.
  const negative = mark === 'D' || mark === 'RC';
  const ref = m[9]?.trim() || null;
  return {
    valueDate,
    bookingDate,
    amount: negative ? -cents : cents,
    transactionType: m[8]!,
    customerReference: ref && ref.toUpperCase() !== 'NONREF' ? ref : null,
    bankReference: m[10]?.trim() || null,
    supplementary: m[11]?.trim() || null,
  };
}

interface Info86 {
  gvc: string | null;
  bookingText: string | null;
  purpose: string;
  counterpartyBic: string | null;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  primaNota: string | null;
  structured: boolean;
}

function parse86(value: string): Info86 {
  const structured = /^(\d{3})(\D)/.exec(value);
  if (!structured) {
    return {
      gvc: null,
      bookingText: null,
      purpose: value,
      counterpartyBic: null,
      counterpartyAccount: null,
      counterpartyName: null,
      primaNota: null,
      structured: false,
    };
  }
  const sep = structured[2]!;
  const body = value.slice(3);
  const parts = new Map<string, string[]>();
  const escaped = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}(\\d{2})([^${escaped}]*)`, 'g');
  for (const m of body.matchAll(re)) {
    const list = parts.get(m[1]!) ?? [];
    list.push(m[2]!);
    parts.set(m[1]!, list);
  }
  const get = (code: string) => (parts.get(code) ?? []).join('');
  const purposeCodes = [
    '20',
    '21',
    '22',
    '23',
    '24',
    '25',
    '26',
    '27',
    '28',
    '29',
    '60',
    '61',
    '62',
    '63',
  ];
  return {
    gvc: structured[1]!,
    bookingText: get('00') || null,
    purpose: purposeCodes.map(get).join(''),
    counterpartyBic: get('30') || null,
    counterpartyAccount: get('31') || null,
    counterpartyName: `${get('32')}${get('33')}` || null,
    primaNota: get('10') || null,
    structured: true,
  };
}

/** Splits `EREF+…SVWZ+…` purpose text into SEPA tag values. */
export function parseSepaTags(purpose: string): Map<string, string> {
  const tags = new Map<string, string>();
  const matches = [...purpose.matchAll(SEPA_TAG)];
  if (matches.length === 0) return tags;
  const leading = purpose.slice(0, matches[0]!.index).trim();
  if (leading) tags.set('', leading);
  matches.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : purpose.length;
    const value = purpose.slice(start, end).trim();
    tags.set(m[1]!, tags.has(m[1]!) ? `${tags.get(m[1]!)} ${value}` : value);
  });
  return tags;
}

function buildTransaction(
  line: StatementLine,
  info: Info86 | null,
  currency: string,
): ParsedTransaction {
  const purpose = info?.purpose ?? '';
  const tags = parseSepaTags(purpose);
  const remittance = tags.size > 0 ? (tags.get('SVWZ') ?? tags.get('') ?? purpose) : purpose;
  const e2e = tags.get('EREF');
  const accountField = info?.counterpartyAccount ?? null;
  const iban =
    accountField && /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(accountField) ? accountField : null;
  return {
    bookingDate: line.bookingDate,
    valueDate: line.valueDate,
    amount: line.amount,
    currency,
    counterpartyName: cleanText(info?.counterpartyName, 140),
    counterpartyIban: iban ?? tags.get('IBAN') ?? null,
    counterpartyBic: cleanText(info?.counterpartyBic ?? tags.get('BIC'), 11),
    remittanceInformation: cleanText(remittance),
    endToEndId: e2e && e2e.toUpperCase() !== 'NOTPROVIDED' ? cleanText(e2e, 35) : null,
    externalId: line.bankReference,
    bankTransactionCode: info?.gvc ?? line.transactionType,
    bookingText: cleanText(info?.bookingText, 200),
    raw: Object.fromEntries(
      Object.entries({
        source: 'mt940',
        transactionType: line.transactionType,
        customerReference: line.customerReference,
        supplementary: line.supplementary,
        primaNota: info?.primaNota,
        account: iban ? undefined : accountField,
        mandateReference: tags.get('MREF'),
        creditorId: tags.get('CRED'),
        ultimateParty: tags.get('ABWA') ?? tags.get('ABWE'),
      }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ),
  };
}

export function parseMt940(content: string): ParsedStatementFile {
  const messages = splitFields(content);
  if (messages.length === 0) {
    throw new StatementParseError('INVALID_MT940', 'No MT940 statement found');
  }
  const warnings: string[] = [];
  const statements: ParsedStatement[] = [];
  for (const fields of messages) {
    if (fields.some((f) => f.tag === '34F')) {
      warnings.push('MT942 interim report (unbooked transactions) skipped');
      continue;
    }
    const reference = fields.find((f) => f.tag === '20')?.value.trim() ?? null;
    const number = fields.find((f) => f.tag === '28C' || f.tag === '28')?.value.trim() ?? null;
    const opening = fields.find((f) => f.tag === '60F' || f.tag === '60M');
    const closing = fields.find((f) => f.tag === '62F' || f.tag === '62M');
    const currency =
      parseBalanceCurrency(opening?.value ?? '') ??
      parseBalanceCurrency(closing?.value ?? '') ??
      'EUR';
    const transactions: ParsedTransaction[] = [];
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i]!;
      if (field.tag !== '61') continue;
      const line = parseLine61(field.value);
      if (!line) {
        warnings.push(`Unreadable :61: line skipped (${field.value.slice(0, 40)})`);
        continue;
      }
      const next = fields[i + 1];
      const info = next?.tag === '86' ? parse86(next.value) : null;
      transactions.push(buildTransaction(line, info, currency));
    }
    const dates = transactions.map((t) => t.bookingDate).sort();
    statements.push({
      statementId: [reference, number].filter(Boolean).join('/') || null,
      accountIdentifier: fields.find((f) => f.tag === '25')?.value.trim() ?? null,
      currency,
      periodFrom: dates[0] ?? parseBalanceDate(opening?.value ?? ''),
      periodTo: dates.at(-1) ?? parseBalanceDate(closing?.value ?? ''),
      transactions,
    });
  }
  return { format: 'MT940', statements, warnings };
}
