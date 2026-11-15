import type { BankStatementFormat, CsvProfile, StatementFormatHint } from '@tix/shared';
import { decodeText } from '../text';
import { StatementParseError, type ParsedStatementFile } from '../types';
import { looksLikeCamt, parseCamt } from './camt';
import { parseCsv } from './csv';
import { looksLikeMt940, parseMt940 } from './mt940';
import { isZip, readZip } from './zip';

export { parseCamt, looksLikeCamt } from './camt';
export { parseMt940, parseSepaTags } from './mt940';
export { parseCsv, tokenizeCsv, detectDelimiter, normalizeHeader } from './csv';
export { readZip, isZip, type ZipEntry } from './zip';

/** Detects the statement format from the decoded content (and the file name as a hint). */
export function detectStatementFormat(content: string, fileName = ''): BankStatementFormat | null {
  const camt = looksLikeCamt(content);
  // camt.054 notifications are stored within the CAMT052 family (see parsers/camt.ts),
  // MT942 interim reports within MT940 (see parsers/mt940.ts).
  if (camt) return camt === 'CAMT054' ? 'CAMT052' : camt;
  if (looksLikeMt940(content)) return 'MT940';
  const lower = fileName.toLowerCase();
  if (/\.(sta|mt940|940|mt942|942)$/.test(lower) && content.includes(':61:')) return 'MT940';
  const firstLines = content.split(/\r?\n/).slice(0, 10).join('\n');
  if (lower.endsWith('.csv') || /[;\t]/.test(firstLines)) return 'CSV';
  return null;
}

export interface StatementSource {
  fileName: string;
  bytes: Uint8Array;
}

/** Unpacks ZIP archives (one level); other files are returned as they are. */
export function expandStatementFiles(source: StatementSource): StatementSource[] {
  if (!isZip(source.bytes)) return [source];
  return readZip(source.bytes)
    .filter((e) => !/(^|\/)(__MACOSX|\.)/.test(e.name))
    .filter((e) => /\.(xml|sta|txt|mt940|940|mt942|942|csv)$/i.test(e.name))
    .map((e) => ({ fileName: `${source.fileName}/${e.name}`, bytes: e.data }));
}

export interface ParseStatementOptions {
  formatHint?: StatementFormatHint;
  csvProfile: CsvProfile;
  /** Currency of the receiving account (CSV files rarely carry one). */
  defaultCurrency: string;
}

/** Parses one (non-archive) statement file. */
export function parseStatementFile(
  source: StatementSource,
  options: ParseStatementOptions,
): ParsedStatementFile {
  if (source.bytes.length === 0) throw new StatementParseError('EMPTY_FILE', 'The file is empty');
  const encoding = options.csvProfile.encoding;
  // XML declares its own encoding; MT940/CSV follow the profile (auto = UTF-8 or Windows-1252).
  let content = decodeText(source.bytes, 'auto');
  const xmlEncoding = /^\s*<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(content)?.[1]?.toLowerCase();
  if (xmlEncoding && /8859-1|latin|1252/.test(xmlEncoding)) {
    content = decodeText(source.bytes, 'windows-1252');
  }
  const hint = options.formatHint ?? 'AUTO';
  const format = hint === 'AUTO' ? detectStatementFormat(content, source.fileName) : hint;
  switch (format) {
    case 'CAMT052':
    case 'CAMT053':
      return parseCamt(content);
    case 'MT940':
      return parseMt940(encoding === 'auto' ? content : decodeText(source.bytes, encoding));
    case 'CSV':
      return parseCsv(
        encoding === 'auto' ? content : decodeText(source.bytes, encoding),
        options.csvProfile,
        options.defaultCurrency,
      );
    default:
      throw new StatementParseError(
        'UNSUPPORTED_FORMAT',
        'Unknown file format – supported are camt.052, camt.053, camt.054, MT940, MT942 and CSV',
      );
  }
}
