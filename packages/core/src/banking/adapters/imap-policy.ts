/**
 * Pure decision logic of the IMAP bank mailbox watcher (no I/O, unit-testable):
 * sender allow-list, per-mail skip classification and the Authentication-Results trust check.
 */

/**
 * `name@example.org` or `@example.org` entries. An empty list matches NOTHING (fail closed):
 * the allow-list is mandatory, a connection without entries does not import.
 */
export function senderAllowed(from: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  if (!from) return false;
  const address = from.trim().toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith('@') ? address.endsWith(e) : address === e;
  });
}

export type MailSkipReason = 'OVERSIZE' | 'SENDER' | 'SUBJECT';

/** Why a mail is not processed (null = process it). Skipped mails are flagged, see `imap.ts`. */
export function classifyMail(input: {
  size: number | null | undefined;
  maxBytes: number;
  from: string | null;
  subject: string | null | undefined;
  allowlist: readonly string[];
  subjectFilter?: string | null;
}): MailSkipReason | null {
  if ((input.size ?? 0) > input.maxBytes) return 'OVERSIZE';
  if (!senderAllowed(input.from, input.allowlist)) return 'SENDER';
  if (
    input.subjectFilter &&
    !(input.subject ?? '').toLowerCase().includes(input.subjectFilter.toLowerCase())
  ) {
    return 'SUBJECT';
  }
  return null;
}

export interface AuthResult {
  method: string;
  result: string;
  /** Lower-cased `ptype.property` → value, e.g. `header.d` → `bank.example`. */
  props: Record<string, string>;
}

export interface ParsedAuthenticationResults {
  /** Lower-cased authserv-id (the host that wrote the header), null when missing. */
  authservId: string | null;
  results: AuthResult[];
}

/**
 * Tokenises one segment (text between top-level `;`): whitespace separates tokens, comments
 * `( ... )` (nested, with backslash escapes) are dropped, quoted strings keep their decoded
 * content inside the token. Returns null when the segment is malformed (unterminated comment /
 * quote).
 */
function tokenizeSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let has = false;
  const flush = () => {
    if (has) tokens.push(current);
    current = '';
    has = false;
  };
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === '(') {
      let depth = 1;
      i += 1;
      while (i < segment.length && depth > 0) {
        const c = segment[i]!;
        if (c === '\\') i += 1;
        else if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        i += 1;
      }
      if (depth > 0) return null;
      i -= 1;
      flush(); // a comment separates tokens like whitespace
    } else if (ch === '"') {
      let closed = false;
      has = true;
      i += 1;
      while (i < segment.length) {
        const c = segment[i]!;
        if (c === '\\') {
          i += 1;
          if (i >= segment.length) return null;
          current += segment[i]!;
        } else if (c === '"') {
          closed = true;
          break;
        } else {
          current += c;
        }
        i += 1;
      }
      if (!closed) return null;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      current += ch;
      has = true;
    }
  }
  flush();
  return tokens;
}

/** Splits at `;` outside comments and quoted strings. An unterminated construct ends the list. */
function splitSegments(header: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i]!;
    if (ch === '\\' && (depth > 0 || quoted)) {
      i += 1;
    } else if (quoted) {
      if (ch === '"') quoted = false;
    } else if (depth > 0) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === '(') {
      depth = 1;
    } else if (ch === ';') {
      out.push(header.slice(start, i));
      start = i + 1;
    }
  }
  out.push(header.slice(start));
  return out;
}

/** Parses one `Authentication-Results` header value (RFC 8601): authserv-id + method results. */
export function parseAuthenticationResultsHeader(header: string): ParsedAuthenticationResults {
  const [head, ...rest] = splitSegments(header);
  const headTokens = tokenizeSegment(head ?? '');
  const authservId = headTokens?.[0] ? headTokens[0].toLowerCase() : null;
  const results: AuthResult[] = [];
  for (const segment of rest) {
    const tokens = tokenizeSegment(segment);
    if (!tokens || tokens.length === 0) continue;
    const first = /^([a-z0-9-]+)=([a-z]+)$/i.exec(tokens[0]!);
    if (!first) continue;
    const props: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      const m = /^([a-z0-9-]+\.[a-z0-9-]+)=(.*)$/is.exec(token);
      if (m) props[m[1]!.toLowerCase()] = m[2]!.toLowerCase();
    }
    results.push({ method: first[1]!.toLowerCase(), result: first[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/** Method results of one header value (without the authserv-id). */
export function parseAuthenticationResults(header: string): AuthResult[] {
  return parseAuthenticationResultsHeader(header).results;
}

function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@');
  return (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase();
}

/** Common two-level public suffixes; a deliberately small, conservative list (no PSL dependency). */
const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.za',
  'co.in',
  'com.br',
  'com.cn',
  'com.mx',
  'com.tr',
  'com.de',
  'co.at',
  'or.at',
  'co.il',
  'co.kr',
  'com.sg',
  'com.hk',
  'com.tw',
]);

const DOMAIN_VALUE = /^[a-z0-9.-]+$/i;

function cleanDomain(raw: string | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim().toLowerCase();
  if (v.includes('@')) v = domainOfAddress(v);
  v = v.replace(/^\.+|\.+$/g, '');
  if (!v || !DOMAIN_VALUE.test(v) || v.includes('..')) return null;
  return v;
}

/** A usable organisational parent: at least 2 labels and not a common public suffix. */
function isOrganisational(domain: string): boolean {
  return domain.split('.').length >= 2 && !COMMON_SECOND_LEVEL_SUFFIXES.has(domain);
}

/**
 * Relaxed alignment on the organisational level, both directions: equal, or one is a parent of
 * the other where the parent has at least 2 labels and is no common public suffix (so
 * `co.uk` / `com.de` never align with `x.co.uk`).
 */
function aligned(fromDomain: string, candidate: string | undefined): boolean {
  const dom = cleanDomain(candidate);
  if (!dom || !fromDomain) return false;
  if (fromDomain === dom) return true;
  if (fromDomain.endsWith(`.${dom}`)) return isOrganisational(dom);
  if (dom.endsWith(`.${fromDomain}`)) return isOrganisational(fromDomain);
  return false;
}

/**
 * True when the TRUSTED Authentication-Results header shows `dkim=pass` with an aligned `header.d`
 * or `dmarc=pass` with an aligned `header.from` – for an allow-listed From address.
 * Fail closed: without a configured `trustedAuthservId` nothing is ever trusted. Only the
 * topmost header whose authserv-id exactly equals it counts (hosts are compared case-insensitive);
 * headers of other ids (added by the sender or earlier hops) are ignored. SPF alone is not enough
 * (the envelope sender says nothing about the visible From).
 */
export function isTrustedMailAuth(input: {
  authenticationResults: string | readonly string[] | null | undefined;
  from: string | null;
  allowlist: readonly string[];
  trustedAuthservId?: string | null;
}): boolean {
  const trustedId = input.trustedAuthservId?.trim().toLowerCase();
  if (!trustedId) return false;
  if (!input.from || !senderAllowed(input.from, input.allowlist)) return false;
  const raw = input.authenticationResults;
  const headers = (Array.isArray(raw) ? raw : [raw]).filter(
    (h): h is string => typeof h === 'string' && h.trim() !== '',
  );
  let chosen: ParsedAuthenticationResults | null = null;
  for (const header of headers) {
    const parsed = parseAuthenticationResultsHeader(header);
    if (parsed.authservId === trustedId) {
      chosen = parsed;
      break;
    }
  }
  if (!chosen) return false;
  const fromDomain = domainOfAddress(input.from);
  return chosen.results.some((r) => {
    if (r.result !== 'pass') return false;
    if (r.method === 'dkim') return aligned(fromDomain, r.props['header.d']);
    if (r.method === 'dmarc') return aligned(fromDomain, r.props['header.from']);
    return false;
  });
}
