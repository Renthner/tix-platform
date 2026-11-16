#!/usr/bin/env node
// Generates a bank statement (camt.053 XML, MT940 or CSV) that pays the open Vorkasse orders of a
// load test copy in a realistic mix, plus `<out>.expected.json` with the outcome the reconciliation
// engine is expected to produce. Import the file in Admin -> Banking, then run
// `verify-reconciliation.mjs`. See docs/LOAD-TEST.md, section "Payment receipt under load".
//
//   node scripts/load/bank-statement.mjs --orders orders.csv [--format camt053|csv|mt940]
//        [--out bank-statement.xml] [--account-iban DE89370400440532013000] [--date YYYY-MM-DD]
//        [--mix exact=82,fuzzy=6,...] [--seed 1] [--limit N] [--split-files K] [--tolerance-cents 50]
//        [--head 20]
//
// Input CSV (header `reference,amount_cents,currency,payer_name,order_number`) is exported with
// scripts/load/open-orders.sql. Plain Node ESM, no dependencies; every output is deterministic for
// the same input and --seed. The expectations follow the rules of the real engine
// (packages/core/src/banking/matching.ts); the integration test
// packages/core/test/bank-statement-tool.integration.test.ts proves them against it.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, rng, shuffle } from './lib/common.mjs';

export const FORMATS = ['camt053', 'csv', 'mt940'];
export const DEFAULT_ACCOUNT_IBAN = 'DE89370400440532013000'; // the well-known documentation IBAN
export const DEFAULT_TOLERANCE_CENTS = 50;
/**
 * Prefix of the end-to-end ids (`<prefix><runId>-<n>`), which also identify the run's bank
 * transactions. The engine searches the end-to-end id for payment references right after the
 * remittance text, so its first character must not be one of the digit look-alikes O Q D I L S B Z:
 * a hyphen-less reference followed by an id starting with one of them would be read with a wrong
 * check digit (an engine quirk, see docs/LOAD-TEST.md).
 */
export const E2E_PREFIX = 'KT';

/** Percent of the orders per scenario. The remainder up to 100 stays unpaid. */
export const DEFAULT_MIX = {
  exact: 82,
  fuzzy: 6,
  underWithin: 2,
  underBeyond: 2,
  over: 2,
  unknown: 2,
  nameOnly: 1,
  duplicate: 1,
  debit: 1,
};

export const SCENARIOS = [...Object.keys(DEFAULT_MIX), 'unpaid'];

// ── small helpers ────────────────────────────────────────────────────────────────────
const seedNumber = (seed) =>
  parseInt(createHash('sha256').update(String(seed)).digest('hex').slice(0, 8), 16);

/** Largest-remainder apportionment: the sum is always exactly `total`. */
export function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const counts = exact.map(Math.floor);
  let rest = total - counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    counts[i] += 1;
    rest -= 1;
  }
  return counts;
}

/** `exact=82,fuzzy=6` -> { exact: 82, fuzzy: 6 }; unknown keys / sums above 100 are errors. */
export function parseMix(text) {
  if (!text) return { ...DEFAULT_MIX };
  const mix = Object.fromEntries(Object.keys(DEFAULT_MIX).map((k) => [k, 0]));
  for (const part of String(text).split(',')) {
    const [key, value] = part.split(/[=:]/).map((s) => s.trim());
    if (!key) continue;
    if (!(key in mix))
      throw new Error(`Unknown mix scenario "${key}" (${Object.keys(mix).join(', ')})`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid mix value for ${key}: ${value}`);
    mix[key] = n;
  }
  const sum = Object.values(mix).reduce((a, b) => a + b, 0);
  if (sum > 100.0001) throw new Error(`The mix adds up to ${sum} %, more than 100`);
  return mix;
}

/**
 * Orders per scenario for `total` orders. Every scenario with a share above 0 gets at least one
 * order when `total` allows it (taken from the biggest scenario).
 */
export function scenarioCounts(total, mix) {
  const sum = Object.values(mix).reduce((a, b) => a + b, 0);
  const weights = [...Object.values(mix), Math.max(0, 100 - sum)];
  const names = SCENARIOS;
  const counts = apportion(total, weights);
  const wanted = weights.filter((w) => w > 0).length;
  if (total >= wanted) {
    for (let i = 0; i < counts.length; i += 1) {
      if (weights[i] > 0 && counts[i] === 0) {
        let big = 0;
        for (let j = 1; j < counts.length; j += 1) if (counts[j] > counts[big]) big = j;
        counts[big] -= 1;
        counts[i] += 1;
      }
    }
  }
  return Object.fromEntries(names.map((n, i) => [n, counts[i]]));
}

// ── payment references ───────────────────────────────────────────────────────────────
export function luhnCheckDigit(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidReference(ref) {
  const m = /^([A-Z]{2,6})-(\d{4})-(\d{4,10})-(\d)$/.exec(ref);
  return !!m && luhnCheckDigit(m[2] + m[3]) === Number(m[4]);
}

export function buildReference(prefix, year, number) {
  const yyyy = String(year).padStart(4, '0');
  return `${prefix}-${yyyy}-${number}-${luhnCheckDigit(yyyy + number)}`;
}

/**
 * Mirror of `extractPaymentReferences` (packages/shared/src/payments/reference.ts), only used for
 * self-checks of the mutators. The integration test runs the real function over every text.
 * Rule v3: with a separator typed between year and number only the longest split counts; a
 * reference with year and number typed together tries the 6-digit generated form first, then the
 * other splits (longest first) for a valid check digit, unless a longer split (7-10 digits) has a
 * set-apart check digit: then only that longer split counts (never re-split).
 */
export function extractReference(text, prefix) {
  const SEP = '[\\s\\-_./:]*';
  const D = '[0-9OQDILSBZ]';
  const look = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };
  const digits = (s) => s.replace(/[OQDILSBZ]/g, (c) => look[c] ?? c);
  const prefixRe = new RegExp(prefix.split('').join('\\s*'), 'g');
  const headRe = new RegExp(`${SEP}(${D}{4})(${SEP})`, 'y');
  const tail = (n) => new RegExp(`(${D}{${n}})${SEP}([0-9](?![0-9])|[OQDILSBZ](?![0-9A-Z]))`, 'y');
  const longestFirst = [10, 9, 8, 7, 6, 5, 4];
  const haystack = text.toUpperCase();
  const out = new Map();
  let from = 0;
  while (from <= haystack.length) {
    prefixRe.lastIndex = from;
    const start = prefixRe.exec(haystack);
    if (!start) break;
    headRe.lastIndex = start.index + start[0].length;
    const head = headRe.exec(haystack);
    const split = (n) => {
      if (!head) return null;
      const re = tail(n);
      re.lastIndex = headRe.lastIndex;
      const m = re.exec(haystack);
      if (!m) return null;
      const year = digits(head[1]);
      const number = digits(m[1]);
      const check = digits(m[2]);
      return {
        reference: `${start[0].replace(/\s+/g, '')}-${year}-${number}-${check}`,
        checksumValid: luhnCheckDigit(year + number) === Number(check),
        end: headRe.lastIndex + m[0].length,
        externalCheck: m[0].length > m[1].length + m[2].length,
      };
    };
    let keep = [];
    const longest = longestFirst.map(split).find(Boolean) ?? null;
    if (longest && head[2].length > 0) keep = [longest];
    else if (longest) {
      const generated = split(6);
      const external = [10, 9, 8, 7].map(split).some((c) => c?.externalCheck);
      if (external) keep = [longest];
      else if (generated?.checksumValid)
        keep = longest.checksumValid ? [generated] : [generated, longest];
      else {
        const retry = longestFirst.map(split).find((c) => c?.checksumValid) ?? null;
        const typed = [generated, longest].find((c) => c && !c.checksumValid) ?? null;
        keep = retry ? (typed ? [retry, typed] : [retry]) : [longest];
      }
    }
    if (keep.length > 0) {
      for (const c of keep)
        if (!out.has(c.reference))
          out.set(c.reference, { reference: c.reference, checksumValid: c.checksumValid });
      from = Math.max(...keep.map((c) => c.end));
    } else from = start.index + 1;
  }
  return [...out.values()].sort((a, b) => Number(b.checksumValid) - Number(a.checksumValid));
}

export const FUZZY_VARIANTS = ['lowercase', 'spaces', 'o-for-zero', 'no-hyphens', 'combined'];

/**
 * Typical customer typos of the reference. The result is always placed LAST in the remittance
 * text, which keeps the texts simple (the engine now reads them correctly with trailing words
 * too, but the generated statements stay conservative).
 */
export function fuzzReference(ref, variant) {
  const [prefix, year, number, check] = ref.split('-');
  const oZero = (s) => s.replace(/0/g, 'O');
  switch (variant) {
    case 'lowercase':
      return ref.toLowerCase();
    case 'spaces':
      return `${prefix} ${year} ${number} ${check}`;
    case 'o-for-zero':
      return `${prefix}-${oZero(year)}-${oZero(number)}-${oZero(check)}`;
    case 'no-hyphens':
      return `${prefix}${year}${number}${check}`;
    case 'combined':
      return `${prefix}${oZero(year)}${oZero(number)}${oZero(check)}`.toLowerCase();
    default:
      throw new Error(`Unknown fuzzy variant ${variant}`);
  }
}

// ── IBANs ────────────────────────────────────────────────────────────────────────────
function mod97(value) {
  let rest = 0;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest;
}

export function isValidIban(input) {
  const iban = String(input).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith('DE') && iban.length !== 22) return false;
  return mod97(iban.slice(4) + iban.slice(0, 4)) === 1;
}

/** German IBAN with correct check digits from a bank code and a 10 digit account number. */
export function germanIban(bankCode, account) {
  const bban = `${bankCode}${String(account).padStart(10, '0')}`;
  const check = String(98 - mod97(`${bban}131400`)).padStart(2, '0');
  return `DE${check}${bban}`;
}

const BANKS = [
  { code: '37040044', bic: 'COBADEFFXXX' },
  { code: '10010010', bic: 'PBNKDEFFXXX' },
  { code: '20070000', bic: 'DEUTDEHHXXX' },
  { code: '50010517', bic: 'INGDDEFFXXX' },
  { code: '12030000', bic: 'BYLADEM1001' },
  { code: '76026000', bic: 'HYVEDEMM460' },
];

/** Deterministic example IBAN + BIC of a payer (same seed + key -> same account). */
export function payerAccount(seed, key) {
  const h = createHash('sha256').update(`${seed}|iban|${key}`).digest();
  const bank = BANKS[h[0] % BANKS.length];
  const account = String(h.readUInt32BE(1) * 7 + h[5]).slice(-10);
  return { iban: germanIban(bank.code, account), bic: bank.bic };
}

// ── input: open orders ───────────────────────────────────────────────────────────────
/** RFC 4180 tokenizer for the orders CSV (quotes, doubled quotes, line breaks inside quotes). */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
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
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export const ORDER_COLUMNS = [
  'reference',
  'amount_cents',
  'currency',
  'payer_name',
  'order_number',
];

export function parseOrdersCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new Error('The orders file is empty');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const at = Object.fromEntries(ORDER_COLUMNS.map((c) => [c, header.indexOf(c)]));
  const missing = ORDER_COLUMNS.filter((c) => at[c] < 0);
  if (missing.length) throw new Error(`The orders file lacks the columns: ${missing.join(', ')}`);
  const orders = [];
  const seen = new Set();
  for (const [i, row] of rows.slice(1).entries()) {
    const amount = Number(row[at.amount_cents]);
    const order = {
      reference: (row[at.reference] ?? '').trim(),
      amountCents: amount,
      currency: (row[at.currency] ?? 'EUR').trim().toUpperCase() || 'EUR',
      payerName: (row[at.payer_name] ?? '').trim(),
      orderNumber: (row[at.order_number] ?? '').trim(),
    };
    if (!isValidReference(order.reference))
      throw new Error(`Line ${i + 2}: "${order.reference}" is not a valid payment reference`);
    if (!Number.isInteger(amount) || amount <= 0)
      throw new Error(`Line ${i + 2}: amount_cents must be a positive integer`);
    if (!order.orderNumber) throw new Error(`Line ${i + 2}: order_number is empty`);
    if (seen.has(order.orderNumber)) throw new Error(`Line ${i + 2}: duplicate order number`);
    seen.add(order.orderNumber);
    orders.push(order);
  }
  return orders;
}

// ── planning ─────────────────────────────────────────────────────────────────────────
const FIRST = ['Anna', 'Jonas', 'Mia', 'Lukas', 'Emma', 'Paul', 'Sofia', 'Felix', 'Clara', 'Noah'];
const LAST = [
  'Berger',
  'Keller',
  'Vogel',
  'Lehmann',
  'Schaefer',
  'Roth',
  'Winter',
  'Brandt',
  'Graf',
];

/** Delta (paid - outstanding) -> engine outcome for a referenced, open order. */
export function classifyDelta(delta, toleranceCents) {
  if (delta > toleranceCents) return { matchStatus: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' };
  if (delta < -toleranceCents) return { matchStatus: 'NEEDS_REVIEW', reviewReason: 'UNDERPAYMENT' };
  return { matchStatus: 'AUTO_MATCHED', reviewReason: null };
}

function runIdFor(seed, prefix) {
  for (let salt = 0; ; salt += 1) {
    const id = createHash('sha256')
      .update(`${seed}|run|${salt}`)
      .digest('base64')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 5);
    // The end-to-end id is searched for references too: it must never look like one.
    if (!id.includes(prefix) && id.length === 5) return id;
  }
}

/**
 * Plans every booking and its expected outcome.
 * Returns { runId, entries, orders, options } - `entries` are the bank bookings in file order.
 */
export function planStatement(orders, options = {}) {
  const seed = options.seed ?? 1;
  const tolerance = options.toleranceCents ?? DEFAULT_TOLERANCE_CENTS;
  const splitFiles = Math.max(1, Math.floor(options.splitFiles ?? 1));
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid --date ${date}`);
  const mix = options.mix ?? { ...DEFAULT_MIX };
  const used = orders.slice(0, options.limit && options.limit > 0 ? options.limit : orders.length);
  if (used.length === 0) throw new Error('No orders to pay');
  const prefix = used[0].reference.split('-')[0];
  const rand = rng(seedNumber(seed));
  const runId = runIdFor(seed, prefix);

  const counts = scenarioCounts(used.length, mix);
  const slots = [];
  for (const [name, n] of Object.entries(counts)) for (let i = 0; i < n; i += 1) slots.push(name);
  const shuffledOrders = shuffle(rand, used);
  const assignments = shuffledOrders.map((order, i) => ({ order, scenario: slots[i] }));

  // Bookings per case; a case (e.g. the two payments of a duplicate) stays in one file.
  const cases = [];
  let fuzzIndex = 0;
  let unknownIndex = 0;
  const payerOf = (a) =>
    a.order.payerName ||
    `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
  const credit = (a, amount, text, name, extra = {}) => ({
    direction: 'CRDT',
    scenario: a.scenario,
    orderNumber: a.order.orderNumber,
    reference: a.order.reference,
    amountCents: amount,
    currency: a.order.currency,
    payerName: name,
    text,
    ...extra,
  });
  for (const a of assignments) {
    const out = a.order.amountCents;
    const ref = a.order.reference;
    const name = a.order.payerName;
    switch (a.scenario) {
      case 'exact':
        cases.push([credit(a, out, `${ref} Ticketbestellung`, payerOf(a))]);
        break;
      case 'fuzzy': {
        const variant = FUZZY_VARIANTS[fuzzIndex % FUZZY_VARIANTS.length];
        fuzzIndex += 1;
        cases.push([
          credit(a, out, `Ticketbestellung ${fuzzReference(ref, variant)}`, payerOf(a), {
            variant,
          }),
        ]);
        break;
      }
      case 'underWithin': {
        const d = Math.max(1, Math.min(tolerance, out - 1));
        cases.push([credit(a, out - d, `${ref} Ticketbestellung`, payerOf(a))]);
        break;
      }
      case 'underBeyond': {
        const d = Math.min(out - 1, tolerance + Math.max(100, Math.round(out * 0.2)));
        cases.push([credit(a, Math.max(1, out - d), `${ref} Ticketbestellung`, payerOf(a))]);
        break;
      }
      case 'over':
        cases.push([credit(a, out + tolerance + 500, `${ref} Ticketbestellung`, payerOf(a))]);
        break;
      case 'unknown': {
        unknownIndex += 1;
        const bogus = buildReference(prefix, 1999, String(100000 + unknownIndex * 7919).slice(-6));
        cases.push([
          {
            direction: 'CRDT',
            scenario: 'unknown',
            orderNumber: null,
            reference: bogus,
            amountCents: 2000 + Math.floor(rand() * 18000),
            currency: a.order.currency,
            payerName: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`,
            text: `${bogus} Konzertkarten`,
          },
        ]);
        break;
      }
      case 'nameOnly':
        cases.push([
          credit(a, out, 'Konzertkarten Zahlung', name || payerOf(a), { reference: null }),
        ]);
        break;
      case 'duplicate':
        cases.push([
          credit(a, out, `${ref} Ticketbestellung`, payerOf(a), { duplicate: 1 }),
          credit(a, out, `${ref} Ticketbestellung`, payerOf(a), { duplicate: 2 }),
        ]);
        break;
      case 'debit':
        cases.push([
          {
            direction: 'DBIT',
            scenario: 'debit',
            orderNumber: a.order.orderNumber,
            reference: ref,
            amountCents: out,
            currency: a.order.currency,
            payerName: 'Muster Rueckerstattung GmbH',
            text: `Erstattung ${ref}`,
          },
        ]);
        break;
      default:
        break; // unpaid
    }
  }
  // Unrelated debits (bank fees, rent ...) on top of the mix: never reference an order.
  const feeCount = Math.max(1, Math.round(used.length * 0.01));
  for (let i = 0; i < feeCount; i += 1) {
    cases.push([
      {
        direction: 'DBIT',
        scenario: 'debit',
        orderNumber: null,
        reference: null,
        amountCents: 590 + i * 10,
        currency: used[0].currency,
        payerName: 'Kontofuehrung Bank',
        text: `Entgelt Kontofuehrung ${date}`,
      },
    ]);
  }

  const order = shuffle(rand, cases);
  const entries = [];
  let n = 0;
  order.forEach((group, caseIndex) => {
    const file = caseIndex % splitFiles;
    for (const e of group) {
      n += 1;
      const key = e.orderNumber ?? `x${n}`;
      const acc = payerAccount(seed, `${e.payerName}|${key}`);
      entries.push({
        ...e,
        n,
        file,
        endToEndId: `${E2E_PREFIX}${runId}-${String(n).padStart(5, '0')}`,
        bankRef: `${E2E_PREFIX}${runId}R${String(n).padStart(5, '0')}`,
        payerIban: acc.iban,
        payerBic: acc.bic,
        bookingDate: date,
        valueDate: date,
      });
    }
  });
  // Within a file the bookings are ordered by n (the shuffled case order).
  return {
    runId,
    entries,
    orders: assignments,
    counts,
    options: { seed, tolerance, splitFiles, date, prefix },
  };
}

// ── expectations ─────────────────────────────────────────────────────────────────────
/**
 * Expected outcome per the real engine:
 *  - DBIT: stored IGNORED, never matched, the referenced order stays open.
 *  - valid reference + open order: |paid - outstanding| <= tolerance -> AUTO_MATCHED, order PAID
 *    (shortfall written off, amount_paid = amount received); above -> OVERPAYMENT, below ->
 *    UNDERPAYMENT review, no payment is recorded, the order stays AWAITING_PAYMENT.
 *  - second transfer for a PAID order -> OVERPAYMENT review, no second payment.
 *  - reference-shaped text without an order -> UNKNOWN_REFERENCE.
 *  - no reference: NAME_MATCH_ONLY (name >= 3 chars and similar to an open buyer) else NO_REFERENCE.
 */
export function buildExpected(plan, extra = {}) {
  const { entries, orders, runId, options } = plan;
  const tol = options.tolerance;
  const byOrder = new Map(orders.map((a) => [a.order.orderNumber, a]));
  const transactions = entries.map((e) => {
    const base = {
      endToEndId: e.endToEndId,
      scenario: e.scenario,
      direction: e.direction,
      amountCents: e.amountCents,
      orderNumber: e.orderNumber,
      reference: e.reference,
      file: e.file,
    };
    if (e.direction === 'DBIT')
      return { ...base, expect: { matchStatus: 'IGNORED', reviewReason: null } };
    if (e.scenario === 'unknown')
      return {
        ...base,
        expect: { matchStatus: 'NEEDS_REVIEW', reviewReason: 'UNKNOWN_REFERENCE' },
      };
    if (e.scenario === 'nameOnly') {
      const reason = e.payerName.length >= 3 ? 'NAME_MATCH_ONLY' : 'NO_REFERENCE';
      return { ...base, expect: { matchStatus: 'NEEDS_REVIEW', reviewReason: reason } };
    }
    const a = byOrder.get(e.orderNumber);
    const delta = e.amountCents - a.order.amountCents;
    if (e.scenario === 'duplicate') {
      return {
        ...base,
        group: `duplicate:${e.orderNumber}`,
        // Which of the two is processed first is not defined: one pays, the other is a Klaerfall.
        expect: {
          oneOf: [
            { matchStatus: 'AUTO_MATCHED', reviewReason: null },
            { matchStatus: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' },
          ],
        },
      };
    }
    return { ...base, expect: classifyDelta(delta, tol) };
  });

  const orderExpect = orders.map((a) => {
    const txs = transactions.filter(
      (t) => t.orderNumber === a.order.orderNumber && t.direction === 'CRDT',
    );
    const own = txs.find((t) => t.expect.matchStatus === 'AUTO_MATCHED');
    const dup = txs.some((t) => t.group);
    const paid = dup ? a.order.amountCents : own ? own.amountCents : 0;
    const isPaid = dup || !!own;
    return {
      orderNumber: a.order.orderNumber,
      reference: a.order.reference,
      scenario: a.scenario,
      outstandingCents: a.order.amountCents,
      status: isPaid ? 'PAID' : 'AWAITING_PAYMENT',
      amountPaidCents: paid,
      capturedPayments: isPaid ? 1 : 0,
    };
  });

  const scenarios = {};
  for (const name of SCENARIOS) {
    const os = orderExpect.filter((o) => o.scenario === name);
    const ts = transactions.filter((t) => t.scenario === name);
    scenarios[name] = {
      orders: os.length,
      transactions: ts.length,
      orderNumbers: os.map((o) => o.orderNumber),
      references: os.map((o) => o.reference),
      expectedOrderStatus: [...new Set(os.map((o) => o.status))],
      expectedTransactions: countBy(ts, (t) => describeExpect(t.expect)),
    };
  }
  const paidOrders = orderExpect.filter((o) => o.status === 'PAID');
  return {
    tool: 'bank-statement.mjs',
    version: 1,
    runId,
    e2ePrefix: E2E_PREFIX,
    seed: options.seed,
    date: options.date,
    toleranceCents: tol,
    splitFiles: options.splitFiles,
    counts: plan.counts,
    totals: {
      orders: orderExpect.length,
      transactions: transactions.length,
      credits: transactions.filter((t) => t.direction === 'CRDT').length,
      debits: transactions.filter((t) => t.direction === 'DBIT').length,
      ordersExpectedPaid: paidOrders.length,
      ordersExpectedOpen: orderExpect.length - paidOrders.length,
      expectedAmountPaidCents: paidOrders.reduce((s, o) => s + o.amountPaidCents, 0),
      expectedReviewCases: transactions.filter(
        (t) => t.expect.matchStatus === 'NEEDS_REVIEW' || t.group,
      ).length,
    },
    scenarios,
    transactions,
    orders: orderExpect,
    ...extra,
  };
}

function describeExpect(expect) {
  if (expect.oneOf) return expect.oneOf.map(describeExpect).join(' | ');
  return expect.reviewReason ? `${expect.matchStatus}/${expect.reviewReason}` : expect.matchStatus;
}

function countBy(list, fn) {
  const out = {};
  for (const item of list) out[fn(item)] = (out[fn(item)] ?? 0) + 1;
  return out;
}

// ── formats ──────────────────────────────────────────────────────────────────────────
const xml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtDot = (cents) =>
  `${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const fmtComma = (cents) =>
  `${Math.floor(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const fmtGerman = (cents) => {
  const int = String(Math.floor(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}${int},${String(Math.abs(cents) % 100).padStart(2, '0')}`;
};
const germanDate = (iso) => iso.split('-').reverse().join('.');

function sums(entries) {
  let net = 0;
  for (const e of entries) net += e.direction === 'CRDT' ? e.amountCents : -e.amountCents;
  return net;
}

export function buildCamt053(entries, ctx) {
  const { accountIban, date, statementId, currency = 'EUR' } = ctx;
  const net = sums(entries);
  const bal = (code, amount, indicator) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${currency}">${fmtDot(amount)}</Amt><CdtDbtInd>${indicator}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  const ntry = entries
    .map((e) => {
      const debit = e.direction === 'DBIT';
      const party = debit ? 'Cdtr' : 'Dbtr';
      return `<Ntry><NtryRef>${e.n}</NtryRef><Amt Ccy="${e.currency}">${fmtDot(e.amountCents)}</Amt><CdtDbtInd>${e.direction}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${e.bookingDate}</Dt></BookgDt><ValDt><Dt>${e.valueDate}</Dt></ValDt><AcctSvcrRef>${xml(e.bankRef)}</AcctSvcrRef><BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${debit ? 'ICDT' : 'RCDT'}</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn></BkTxCd><NtryDtls><TxDtls><Refs><EndToEndId>${xml(e.endToEndId)}</EndToEndId></Refs><RltdPties><${party}><Nm>${xml(e.payerName)}</Nm></${party}><${party}Acct><Id><IBAN>${e.payerIban}</IBAN></Id></${party}Acct></RltdPties><RltdAgts><${party}Agt><FinInstnId><BICFI>${e.payerBic}</BICFI></FinInstnId></${party}Agt></RltdAgts><RmtInf><Ustrd>${xml(e.text)}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<BkToCstmrStmt>
<GrpHdr><MsgId>${xml(statementId)}</MsgId><CreDtTm>${date}T23:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${xml(statementId)}</Id><ElctrncSeqNb>1</ElctrncSeqNb><CreDtTm>${date}T23:00:00</CreDtTm>
<FrToDt><FrDtTm>${date}T00:00:00</FrDtTm><ToDtTm>${date}T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${accountIban}</IBAN></Id><Ccy>${currency}</Ccy><Ownr><Nm>Load Test Organiser</Nm></Ownr></Acct>
${bal('OPBD', 0, 'CRDT')}
${bal('CLBD', Math.abs(net), net < 0 ? 'DBIT' : 'CRDT')}
${ntry}
</Stmt>
</BkToCstmrStmt>
</Document>
`;
}

/** Chunks of at most 27 characters; a chunk never ends with a space (the parser strips those). */
export function mt940Chunks(text, size = 27) {
  const chunks = [];
  let rest = text;
  while (rest.length > 0) {
    let take = Math.min(size, rest.length);
    while (take > 1 && take < rest.length && rest[take - 1] === ' ') take -= 1;
    chunks.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return chunks;
}

const mt = (s) =>
  String(s ?? '')
    .replace(/[?\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function buildMt940(entries, ctx) {
  const { accountIban, date, statementId, currency = 'EUR' } = ctx;
  const yymmdd = date.slice(2).replace(/-/g, '');
  const mmdd = date.slice(5).replace('-', '');
  const net = sums(entries);
  const lines = [
    `:20:${statementId}`,
    `:25:${accountIban}`,
    `:28C:1/1`,
    `:60F:C${yymmdd}${currency}0,`,
  ];
  for (const e of entries) {
    const debit = e.direction === 'DBIT';
    lines.push(
      `:61:${yymmdd}${mmdd}${debit ? 'D' : 'C'}${fmtComma(e.amountCents)}NTRFNONREF//${e.bankRef}`,
    );
    const purpose = `EREF+${e.endToEndId}SVWZ+${mt(e.text)}`;
    const name = mt(e.payerName);
    const parts = [
      `166?00${debit ? 'LASTSCHRIFT' : 'GUTSCHRIFT'}`,
      '?109999',
      ...mt940Chunks(purpose).map((c, i) => `?${String(20 + i).padStart(2, '0')}${c}`),
      `?30${e.payerBic}`,
      `?31${e.payerIban}`,
      `?32${name.slice(0, 27)}`,
    ];
    if (name.length > 27) parts.push(`?33${name.slice(27, 54)}`);
    lines.push(`:86:${parts[0]}`, ...parts.slice(1));
  }
  const closing = Math.abs(net);
  lines.push(`:62F:${net < 0 ? 'D' : 'C'}${yymmdd}${currency}${fmtComma(closing)}`, '-');
  return `${lines.join('\r\n')}\r\n`;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_HEADER = [
  'Buchungstag',
  'Valuta',
  'Name Zahlungsbeteiligter',
  'IBAN Zahlungsbeteiligter',
  'BIC (SWIFT-Code) Zahlungsbeteiligter',
  'Buchungstext',
  'Verwendungszweck',
  'Betrag',
  'Waehrung',
  'Kundenreferenz (End-to-End)',
  'IBAN Auftragskonto',
];

export function buildCsv(entries, ctx) {
  const rows = [CSV_HEADER];
  for (const e of entries) {
    const debit = e.direction === 'DBIT';
    rows.push([
      germanDate(e.bookingDate),
      germanDate(e.valueDate),
      e.payerName,
      e.payerIban,
      e.payerBic,
      debit ? 'Lastschrift' : 'Gutschrift',
      e.text,
      fmtGerman(debit ? -e.amountCents : e.amountCents),
      e.currency,
      e.endToEndId,
      ctx.accountIban,
    ]);
  }
  return `${rows.map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

export const FORMAT_INFO = {
  camt053: { ext: 'xml', build: buildCamt053 },
  mt940: { ext: 'sta', build: buildMt940 },
  csv: { ext: 'csv', build: buildCsv },
};

/** Renders the statement of one file index. */
export function buildStatement(plan, format, fileIndex = 0, options = {}) {
  const info = FORMAT_INFO[format];
  if (!info) throw new Error(`Unknown format ${format} (${FORMATS.join(', ')})`);
  const accountIban = (options.accountIban ?? DEFAULT_ACCOUNT_IBAN)
    .replace(/\s/g, '')
    .toUpperCase();
  if (!isValidIban(accountIban))
    throw new Error(`${accountIban} is not a valid IBAN (check digits)`);
  const entries = plan.entries.filter((e) => e.file === fileIndex);
  return info.build(entries, {
    accountIban,
    date: plan.options.date,
    statementId: `${E2E_PREFIX}${plan.runId}-${fileIndex + 1}`,
    currency: plan.entries[0]?.currency ?? 'EUR',
  });
}

/** Whole run: plan, files and expectation. `out` is the base file name. */
export function generate(orders, options = {}) {
  const format = options.format ?? 'camt053';
  const plan = planStatement(orders, options);
  const ext = FORMAT_INFO[format]?.ext ?? 'txt';
  const out = options.out ?? `bank-statement.${ext}`;
  const stem = out.replace(/\.[^./\\]+$/, '');
  const files = [];
  for (let i = 0; i < plan.options.splitFiles; i += 1) {
    files.push({
      name:
        plan.options.splitFiles > 1 ? `${stem}-${i + 1}of${plan.options.splitFiles}.${ext}` : out,
      content: buildStatement(plan, format, i, options),
      transactions: plan.entries.filter((e) => e.file === i).length,
    });
  }
  const expected = buildExpected(plan, {
    format,
    accountIban: (options.accountIban ?? DEFAULT_ACCOUNT_IBAN).replace(/\s/g, '').toUpperCase(),
    files: files.map((f) => ({ name: f.name, transactions: f.transactions })),
  });
  return { plan, files, expected, expectedName: `${out}.expected.json` };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────
const HELP = `Usage: node scripts/load/bank-statement.mjs --orders <orders.csv> [options]
  --orders <file>        open orders (reference,amount_cents,currency,payer_name,order_number), see scripts/load/open-orders.sql
  --format <f>           camt053 (default) | csv | mt940
  --out <file>           output file (default bank-statement.<ext>); <out>.expected.json is written next to it
  --account-iban <iban>  IBAN of the bank account the import is for (default ${DEFAULT_ACCOUNT_IBAN})
  --date <YYYY-MM-DD>    booking and value date (default today; not earlier than the order creation)
  --mix <k=v,...>        percent per scenario: ${Object.keys(DEFAULT_MIX).join(', ')} (rest stays unpaid)
  --seed <n>             seed (default 1)   --limit <N>  use only the first N orders
  --split-files <K>      write K statement files   --tolerance-cents <c>  (default ${DEFAULT_TOLERANCE_CENTS}) must equal the
                         setting Payments -> Bank transfer -> matching tolerance of the target
  --head <N>             print the first N lines of every file`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || !args.orders) {
    console.log(HELP);
    process.exit(args.orders || args.help || args.h ? 0 : 2);
  }
  try {
    const orders = parseOrdersCsv(readFileSync(resolve(String(args.orders)), 'utf8'));
    const format = String(args.format ?? 'camt053');
    const result = generate(orders, {
      format,
      out: args.out ? String(args.out) : undefined,
      accountIban: args['account-iban'] ? String(args['account-iban']) : undefined,
      date: args.date ? String(args.date) : undefined,
      mix: parseMix(args.mix),
      seed: args.seed ?? 1,
      limit: args.limit ? Number(args.limit) : undefined,
      splitFiles: args['split-files'] ? Number(args['split-files']) : 1,
      toleranceCents:
        args['tolerance-cents'] !== undefined
          ? Number(args['tolerance-cents'])
          : DEFAULT_TOLERANCE_CENTS,
    });
    for (const f of result.files) {
      writeFileSync(resolve(f.name), f.content);
      console.log(
        `Wrote ${resolve(f.name)} (${f.transactions} bookings, ${(Buffer.byteLength(f.content) / 1024).toFixed(1)} KB)`,
      );
      const head = Number(args.head ?? 0);
      if (head > 0) console.log(f.content.split(/\r?\n/).slice(0, head).join('\n') + '\n...');
    }
    writeFileSync(resolve(result.expectedName), `${JSON.stringify(result.expected, null, 2)}\n`);
    console.log(`Wrote ${resolve(result.expectedName)}`);
    const t = result.expected.totals;
    console.log(
      `\nRun id ${result.expected.runId}, format ${format}, date ${result.expected.date}, account ${result.expected.accountIban}`,
    );
    console.log(
      `${t.orders} orders, ${t.transactions} bookings (${t.credits} credits, ${t.debits} debits)`,
    );
    console.log(
      `expected: ${t.ordersExpectedPaid} orders PAID (${(t.expectedAmountPaidCents / 100).toFixed(2)}), ${t.ordersExpectedOpen} stay AWAITING_PAYMENT, ${t.expectedReviewCases} review cases`,
    );
    for (const [name, s] of Object.entries(result.expected.scenarios)) {
      if (s.orders === 0 && s.transactions === 0) continue;
      const outcomes = Object.entries(s.expectedTransactions)
        .map(([k, v]) => `${v}x ${k}`)
        .join(', ');
      console.log(
        `  ${name.padEnd(12)} ${String(s.orders).padStart(5)} orders  ${outcomes || '-'}`,
      );
    }
    console.log(
      `\nSet the matching tolerance of the target to ${result.expected.toleranceCents} cents (Settings -> Payments), then import in Admin -> Banking.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
