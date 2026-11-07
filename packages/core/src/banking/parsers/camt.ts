import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { cleanText, parseAmountToCents } from '../text';
import {
  StatementParseError,
  type ParsedStatement,
  type ParsedStatementFile,
  type ParsedTransaction,
} from '../types';

/**
 * ISO 20022 cash management statements:
 *  - camt.053 (BkToCstmrStmt, end-of-day statement)
 *  - camt.052 (BkToCstmrAcctRpt, intraday / account report – also what FinTS HKCAZ returns)
 * Versions .001.02 – .001.13 share the element names used here. Only booked entries
 * (Sts = BOOK) are imported; pending/information entries are skipped. Batch entries with
 * several transaction details are split into one transaction per detail when each detail
 * carries its own amount.
 */

type XmlNode = Record<string, unknown>;

const ARRAY_TAGS = new Set([
  'Stmt',
  'Rpt',
  'Ntry',
  'NtryDtls',
  'TxDtls',
  'Ustrd',
  'Strd',
  'Bal',
  'AdrLine',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const isNode = (v: unknown): v is XmlNode =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function child(node: unknown, ...path: string[]): unknown {
  let current: unknown = node;
  for (const key of path) {
    if (Array.isArray(current)) current = current[0];
    if (!isNode(current)) return undefined;
    current = current[key];
  }
  return current;
}

function text(node: unknown, ...path: string[]): string | null {
  let value = path.length ? child(node, ...path) : node;
  if (Array.isArray(value)) value = value[0];
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (isNode(value) && typeof value['#text'] === 'string') return value['#text'].trim() || null;
  return null;
}

function list(node: unknown, ...path: string[]): unknown[] {
  const value = child(node, ...path);
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function dateOf(node: unknown): string | null {
  const value = text(node, 'Dt') ?? text(node, 'DtTm');
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function amountOf(node: unknown): { cents: number; currency: string | null } | null {
  if (node === undefined) return null;
  const raw = text(node);
  if (!raw) return null;
  const cents = parseAmountToCents(raw, '.');
  if (cents === null) return null;
  const currency = isNode(node) && typeof node['@_Ccy'] === 'string' ? node['@_Ccy'] : null;
  return { cents: Math.abs(cents), currency };
}

function partyName(party: unknown): string | null {
  return (
    text(party, 'Nm') ??
    text(party, 'Pty', 'Nm') ??
    cleanText(
      list(party, 'PstlAdr', 'AdrLine')
        .map((l) => text(l))
        .join(' '),
    )
  );
}

function accountId(account: unknown): string | null {
  return text(account, 'Id', 'IBAN') ?? text(account, 'Id', 'Othr', 'Id') ?? text(account, 'IBAN');
}

function agentBic(agent: unknown): string | null {
  return text(agent, 'FinInstnId', 'BICFI') ?? text(agent, 'FinInstnId', 'BIC');
}

/** Ustrd lines: wrapped lines (≥ 27 chars) are joined without a space. */
function joinRemittance(lines: string[]): string | null {
  let out = '';
  for (const line of lines) {
    if (!line) continue;
    if (out === '') out = line;
    else out += out.length % 35 === 0 || lastSegmentLength(out) >= 27 ? line : ` ${line}`;
  }
  return cleanText(out);
}

function lastSegmentLength(s: string): number {
  return s.length - (s.lastIndexOf(' ') + 1);
}

function bankTransactionCode(node: unknown): string | null {
  const prtry = text(node, 'BkTxCd', 'Prtry', 'Cd');
  if (prtry) return prtry;
  const domain = text(node, 'BkTxCd', 'Domn', 'Cd');
  const family = text(node, 'BkTxCd', 'Domn', 'Fmly', 'Cd');
  const sub = text(node, 'BkTxCd', 'Domn', 'Fmly', 'SubFmlyCd');
  return [domain, family, sub].filter(Boolean).join('/') || null;
}

function entryStatus(entry: unknown): string | null {
  return text(entry, 'Sts', 'Cd') ?? text(entry, 'Sts');
}

function remittanceOf(details: unknown): string | null {
  const unstructured = list(details, 'RmtInf', 'Ustrd')
    .map((l) => text(l) ?? '')
    .filter(Boolean);
  const structured = list(details, 'RmtInf', 'Strd')
    .map((s) => text(s, 'CdtrRefInf', 'Ref'))
    .filter((v): v is string => !!v);
  return joinRemittance([...unstructured, ...structured]);
}

function parseEntry(entry: unknown, fallbackCurrency: string | null): ParsedTransaction[] {
  const amount = amountOf(child(entry, 'Amt'));
  const bookingDate = dateOf(child(entry, 'BookgDt'));
  if (!amount || !bookingDate) return [];
  const isDebit = text(entry, 'CdtDbtInd') === 'DBIT';
  const valueDate = dateOf(child(entry, 'ValDt'));
  const entryRef = text(entry, 'AcctSvcrRef');
  const entryCode = bankTransactionCode(entry);
  const bookingText = cleanText(text(entry, 'AddtlNtryInf'), 500);
  const currency = amount.currency ?? fallbackCurrency ?? 'EUR';
  const details = list(entry, 'NtryDtls').flatMap((d) => list(d, 'TxDtls'));

  const build = (
    detail: unknown,
    cents: number,
    debit: boolean,
    ccy: string,
    index: number,
  ): ParsedTransaction => {
    const counterparty = debit ? 'Cdtr' : 'Dbtr';
    const party = child(detail, 'RltdPties', counterparty);
    const ultimate = child(detail, 'RltdPties', debit ? 'UltmtCdtr' : 'UltmtDbtr');
    const e2e = text(detail, 'Refs', 'EndToEndId');
    return {
      bookingDate,
      valueDate,
      amount: debit ? -cents : cents,
      currency: ccy.toUpperCase(),
      counterpartyName: cleanText(partyName(party), 140),
      counterpartyIban: accountId(child(detail, 'RltdPties', `${counterparty}Acct`)),
      counterpartyBic: agentBic(child(detail, 'RltdAgts', `${counterparty}Agt`)),
      remittanceInformation: remittanceOf(detail),
      endToEndId: e2e && e2e.toUpperCase() !== 'NOTPROVIDED' ? e2e : null,
      externalId: text(detail, 'Refs', 'AcctSvcrRef') ?? entryRef,
      bankTransactionCode: bankTransactionCode(detail) ?? entryCode,
      bookingText,
      raw: compact({
        source: 'camt',
        detailIndex: details.length > 1 ? index : undefined,
        mandateId: text(detail, 'Refs', 'MndtId'),
        ultimateParty: cleanText(partyName(ultimate), 140),
        additionalInfo: cleanText(text(detail, 'AddtlTxInf'), 500),
        reversal: text(entry, 'RvslInd') === 'true' || undefined,
      }),
    };
  };

  if (details.length > 1) {
    const split = details.map((detail) => {
      const own =
        amountOf(child(detail, 'Amt')) ?? amountOf(child(detail, 'AmtDtls', 'TxAmt', 'Amt'));
      const ind = text(detail, 'CdtDbtInd');
      return { detail, own, debit: ind ? ind === 'DBIT' : isDebit };
    });
    const sum = split.reduce((s, d) => s + (d.own ? (d.debit ? -1 : 1) * d.own.cents : 0), 0);
    if (
      split.every((d) => d.own) &&
      Math.abs(sum) === amount.cents &&
      sum < 0 === isDebit &&
      amount.cents > 0
    ) {
      return split.map((d, i) =>
        build(d.detail, d.own!.cents, d.debit, d.own!.currency ?? currency, i),
      );
    }
  }
  return [build(details[0], amount.cents, isDebit, currency, 0)];
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

function parseReport(report: unknown, warnings: string[]): ParsedStatement {
  const currency = text(report, 'Acct', 'Ccy');
  const transactions: ParsedTransaction[] = [];
  let skipped = 0;
  for (const entry of list(report, 'Ntry')) {
    const status = entryStatus(entry);
    if (status && status !== 'BOOK') {
      skipped += 1;
      continue;
    }
    const parsed = parseEntry(entry, currency);
    if (parsed.length === 0) warnings.push('CAMT entry without amount or booking date skipped');
    transactions.push(...parsed);
  }
  if (skipped > 0) warnings.push(`${skipped} pending (not booked) CAMT entries skipped`);
  const dates = transactions.map((t) => t.bookingDate).sort();
  const from = text(report, 'FrToDt', 'FrDtTm') ?? text(report, 'FrToDt', 'FrDt');
  const to = text(report, 'FrToDt', 'ToDtTm') ?? text(report, 'FrToDt', 'ToDt');
  return {
    statementId: text(report, 'Id') ?? text(report, 'ElctrncSeqNb'),
    accountIdentifier: accountId(child(report, 'Acct')),
    currency,
    periodFrom: from?.slice(0, 10) ?? dates[0] ?? null,
    periodTo: to?.slice(0, 10) ?? dates.at(-1) ?? null,
    transactions,
  };
}

export function looksLikeCamt(content: string): 'CAMT053' | 'CAMT052' | 'CAMT054' | null {
  const head = content.slice(0, 4000);
  if (!/<(?:\w+:)?Document\b|<\?xml/.test(head)) return null;
  if (/BkToCstmrStmt|camt\.053/.test(head)) return 'CAMT053';
  if (/BkToCstmrAcctRpt|camt\.052/.test(head)) return 'CAMT052';
  if (/BkToCstmrDbtCdtNtfctn|camt\.054/.test(head)) return 'CAMT054';
  return null;
}

export function parseCamt(xml: string): ParsedStatementFile {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new StatementParseError('INVALID_XML', 'XML documents with DTDs are not accepted');
  }
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new StatementParseError('INVALID_XML', `Invalid XML: ${valid.err.msg}`);
  }
  const doc = parser.parse(xml) as XmlNode;
  const root = child(doc, 'Document') ?? doc;
  const warnings: string[] = [];
  const stmt = child(root, 'BkToCstmrStmt');
  if (stmt) {
    return {
      format: 'CAMT053',
      statements: list(stmt, 'Stmt').map((s) => parseReport(s, warnings)),
      warnings,
    };
  }
  const rpt = child(root, 'BkToCstmrAcctRpt');
  if (rpt) {
    return {
      format: 'CAMT052',
      statements: list(rpt, 'Rpt').map((r) => parseReport(r, warnings)),
      warnings,
    };
  }
  if (child(root, 'BkToCstmrDbtCdtNtfctn')) {
    throw new StatementParseError(
      'UNSUPPORTED_FORMAT',
      'camt.054 notifications are not supported – please export camt.053 or camt.052',
    );
  }
  throw new StatementParseError('UNSUPPORTED_FORMAT', 'Not a camt.052 / camt.053 document');
}
