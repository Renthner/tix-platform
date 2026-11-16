#!/usr/bin/env node
// Watches the automatic reconciliation of an imported bank statement and checks the result against
// the `<statement>.expected.json` written by bank-statement.mjs. Read-only: it only runs SELECTs
// through the command you give it. See docs/LOAD-TEST.md, section "Payment receipt under load".
//
//   node scripts/load/verify-reconciliation.mjs --expected bank-statement.xml.expected.json \
//     --psql-cmd "docker exec -i <postgres-container> psql -U tix -d tix -At" \
//     [--wait 600s] [--interval 5s] [--stable-polls 3] [--out summary.json] \
//     [--logs-cmd "docker logs --since 20m <app-container>"] [--skip-fulfillment]
//
// --psql-cmd is started through the shell, the SQL is written to its standard input, and every
// result line starting with `TIXV:<kind>:` is read (all other output - SET, headers, notices - is
// ignored), so any psql output format works. The command may be `ssh host docker exec -i ...`.
// Do not put passwords into the arguments (use PGPASSWORD / .pgpass / the container).
// Exit code 0 = settled and every check passed, 1 = a check failed or the state did not settle in
// time, 2 = usage error.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/common.mjs';

// ── queries ──────────────────────────────────────────────────────────────────────────
// All SQL of the tool lives here. Every query is a plain SELECT that returns one line per result
// row, `TIXV:<kind>:<json>`, scoped to the run: bank transactions by their end-to-end id prefix
// (`LT<runId>-`, set by bank-statement.mjs) and orders by the order numbers of expected.json.

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Guards the two values that are interpolated into SQL. */
export function assertScope(expected) {
  if (!/^[A-Z0-9]{3,12}$/.test(String(expected.runId ?? '')))
    throw new Error('expected.json has no valid runId');
  for (const o of expected.orders ?? [])
    if (!/^[\w./-]{1,64}$/.test(o.orderNumber))
      throw new Error(`Unexpected order number ${o.orderNumber}`);
}

const orderList = (expected) =>
  `array[${expected.orders.map((o) => sqlString(o.orderNumber)).join(',')}]::text[]`;
const txFilter = (expected) =>
  `t.end_to_end_id like ${sqlString(`${expected.e2ePrefix ?? 'KT'}${expected.runId}-%`)}`;

export const QUERIES = {
  /** Makes the session read-only in case the connection user could write. Its output is ignored. */
  readOnly: () => 'set default_transaction_read_only = on;',

  /** Matching tolerance and reference prefix as configured on the target (Settings -> Payments). */
  settings: () => `
select 'TIXV:settings:' || json_build_object(
  'toleranceCents', coalesce((select (value->>'autoMatchToleranceCents')::int from system_settings where key = 'bankTransfer'), 0),
  'prefix', coalesce((select value->>'paymentReferencePrefix' from system_settings where key = 'bankTransfer'), 'TIX')
)::text;`,

  /**
   * One line per poll: bank transactions by match status, orders by status, invoices, valid
   * tickets, e-mails by status, plus the epoch-millisecond timestamps used for the timings.
   * Timings use created_at of the rows (orders.paid_at is the booking date, not the processing time).
   */
  counts: (expected) => `
with scope as (select id from orders where order_number = any(${orderList(expected)})),
     tx as (select t.* from bank_transactions t where ${txFilter(expected)}),
     mail as (select m.* from email_messages m where m.order_id in (select id from scope))
select 'TIXV:counts:' || json_build_object(
  'now', (extract(epoch from now()) * 1000)::bigint,
  'tx', (select coalesce(json_object_agg(s, c), '{}'::json) from (select match_status::text s, count(*) c from tx group by 1) q),
  'txReview', (select coalesce(json_object_agg(s, c), '{}'::json) from (select review_reason::text s, count(*) c from tx where match_status = 'NEEDS_REVIEW' group by 1) q),
  'orders', (select coalesce(json_object_agg(s, c), '{}'::json) from (select status::text s, count(*) c from orders where id in (select id from scope) group by 1) q),
  'payments', (select count(*) from payments where order_id in (select id from scope) and status = 'CAPTURED'),
  'invoices', (select count(*) from invoices where order_id in (select id from scope) and type = 'INVOICE'),
  'tickets', (select count(*) from tickets where order_id in (select id from scope) and status = 'VALID'),
  'mail', (select coalesce(json_object_agg(s, c), '{}'::json) from (select status::text s, count(*) c from mail group by 1) q),
  'paymentMails', (select count(*) from mail where template_key = 'PAYMENT_RECEIVED_TICKETS'),
  'firstTx', (select (extract(epoch from min(created_at)) * 1000)::bigint from tx),
  'lastTxUpdate', (select (extract(epoch from max(updated_at)) * 1000)::bigint from tx),
  'lastPayment', (select (extract(epoch from max(created_at)) * 1000)::bigint from payments where order_id in (select id from scope) and method = 'BANK_TRANSFER'),
  'lastInvoice', (select (extract(epoch from max(created_at)) * 1000)::bigint from invoices where order_id in (select id from scope)),
  'lastTicket', (select (extract(epoch from max(issued_at)) * 1000)::bigint from tickets where order_id in (select id from scope)),
  'lastPaymentMail', (select (extract(epoch from max(created_at)) * 1000)::bigint from mail where template_key = 'PAYMENT_RECEIVED_TICKETS')
)::text;`,

  /** One line per imported bank transaction of the run, with its allocations and payments. */
  transactions: (expected) => `
select 'TIXV:tx:' || json_build_object(
  'e2e', t.end_to_end_id,
  'status', t.match_status::text,
  'reason', t.review_reason::text,
  'amount', t.amount,
  'reference', t.extracted_reference,
  'allocations', (select count(*) from bank_transaction_allocations a where a.bank_transaction_id = t.id and a.reversed_at is null),
  'allocatedCents', (select coalesce(sum(a.amount), 0) from bank_transaction_allocations a where a.bank_transaction_id = t.id and a.reversed_at is null),
  'payments', (select count(*) from payments p where p.bank_transaction_id = t.id and p.status = 'CAPTURED')
)::text
from bank_transactions t where ${txFilter(expected)} order by t.end_to_end_id;`,

  /** One line per order of the run: status, money, payments, allocations and the fulfilment results. */
  orders: (expected) => `
select 'TIXV:order:' || json_build_object(
  'orderNumber', o.order_number,
  'status', o.status::text,
  'totalGross', o.total_gross,
  'amountPaid', o.amount_paid,
  'items', (select count(*) from order_items i where i.order_id = o.id),
  'captured', (select count(*) from payments p where p.order_id = o.id and p.status = 'CAPTURED'),
  'capturedCents', (select coalesce(sum(p.amount), 0) from payments p where p.order_id = o.id and p.status = 'CAPTURED'),
  'bankCapturedCents', (select coalesce(sum(p.amount), 0) from payments p where p.order_id = o.id and p.status = 'CAPTURED' and p.method = 'BANK_TRANSFER'),
  'allocations', (select count(*) from bank_transaction_allocations a where a.order_id = o.id and a.reversed_at is null),
  'allocatedCents', (select coalesce(sum(a.amount), 0) from bank_transaction_allocations a where a.order_id = o.id and a.reversed_at is null),
  'invoices', (select count(*) from invoices v where v.order_id = o.id and v.type = 'INVOICE'),
  'tickets', (select count(*) from tickets k where k.order_id = o.id and k.status = 'VALID'),
  'paymentMails', (select count(*) from email_messages m where m.order_id = o.id and m.template_key = 'PAYMENT_RECEIVED_TICKETS')
)::text
from orders o where o.order_number = any(${orderList(expected)}) order by o.order_number;`,
};

/** Only SELECT / WITH / SET default_transaction_read_only statements may leave this tool. */
export function assertReadOnlySql(sql) {
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statements) {
    if (!/^(select|with|set default_transaction_read_only)\b/i.test(s))
      throw new Error(`Refusing to run non-read-only SQL: ${s.slice(0, 40)}`);
  }
}

// ── parsing / helpers ────────────────────────────────────────────────────────────────
/** Reads `TIXV:<kind>:<json>` lines out of arbitrary psql output. */
export function parseMarkerLines(output) {
  const out = [];
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^TIXV:([a-z]+):(.*)$/.exec(line.trim());
    if (!m) continue;
    try {
      out.push({ kind: m[1], data: JSON.parse(m[2]) });
    } catch {
      /* a line cut by the transport is skipped */
    }
  }
  return out;
}

export function parseDuration(text, fallbackMs) {
  if (text === undefined || text === true) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(text).trim());
  if (!m) throw new Error(`Invalid duration "${text}" (examples: 500ms, 5s, 10m)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'];
  return Math.round(Number(m[1]) * unit);
}

/** Counts lines of a log: pino JSON with level >= 50, or lines containing error / fatal. */
export function analyzeLogs(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const byMessage = new Map();
  let errors = 0;
  for (const line of lines) {
    let message = null;
    try {
      const j = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
      if (typeof j === 'object' && j && typeof j.level === 'number') {
        if (j.level >= 50) message = String(j.msg ?? j.message ?? 'error');
      } else if (/\b(error|fatal)\b/i.test(line)) message = line.slice(0, 160);
    } catch {
      if (/\b(error|fatal)\b/i.test(line)) message = line.replace(/\s+/g, ' ').slice(0, 160);
    }
    if (message !== null) {
      errors += 1;
      byMessage.set(message, (byMessage.get(message) ?? 0) + 1);
    }
  }
  const top = [...byMessage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { lines: lines.length, errors, top: top.map(([message, count]) => ({ message, count })) };
}

// ── evaluation (pure) ────────────────────────────────────────────────────────────────
/**
 * Compares the database snapshot with expected.json.
 * snapshot = { settings?, transactions: [...tx lines], orders: [...order lines] }
 * options.fulfillment = false skips the invoice / ticket / payment mail checks (no worker running,
 * or orders without items).
 * Returns { ok, checks: [{ scenario, check, total, failed, samples }], failures }.
 */
export function evaluate(snapshot, expected, options = {}) {
  const fulfillment = options.fulfillment !== false;
  const checks = new Map();
  const record = (scenario, check, pass, detail) => {
    const key = `${scenario}|${check}`;
    const entry = checks.get(key) ?? { scenario, check, total: 0, failed: 0, samples: [] };
    entry.total += 1;
    if (!pass) {
      entry.failed += 1;
      if (entry.samples.length < 5) entry.samples.push(detail);
    }
    checks.set(key, entry);
  };
  const txByE2e = new Map(snapshot.transactions.map((t) => [t.e2e, t]));
  const orderByNumber = new Map(snapshot.orders.map((o) => [o.orderNumber, o]));

  // Orders
  for (const exp of expected.orders) {
    const row = orderByNumber.get(exp.orderNumber);
    const s = exp.scenario;
    if (!row) {
      record(s, 'order exists', false, exp.orderNumber);
      continue;
    }
    const label = exp.orderNumber;
    record(
      s,
      'order status',
      row.status === exp.status,
      `${label}: ${row.status}, expected ${exp.status}`,
    );
    record(
      s,
      'order amount_paid',
      row.amountPaid === exp.amountPaidCents,
      `${label}: ${row.amountPaid}, expected ${exp.amountPaidCents}`,
    );
    record(
      s,
      'captured payments',
      row.captured === exp.capturedPayments,
      `${label}: ${row.captured}, expected ${exp.capturedPayments}`,
    );
    if (exp.status === 'PAID') {
      record(
        s,
        'allocation per payment',
        row.allocations === 1 && row.allocatedCents === row.bankCapturedCents,
        `${label}: ${row.allocations} allocations, ${row.allocatedCents} allocated, ${row.bankCapturedCents} paid`,
      );
      if (fulfillment) {
        record(s, 'invoice issued', row.invoices === 1, `${label}: ${row.invoices} invoices`);
        if (row.items > 0)
          record(s, 'tickets issued', row.tickets > 0, `${label}: ${row.tickets} tickets`);
        record(
          s,
          'payment mail queued',
          row.paymentMails >= 1,
          `${label}: ${row.paymentMails} mails`,
        );
      }
    } else {
      record(
        s,
        'no payment effects',
        row.captured === 0 &&
          row.allocations === 0 &&
          row.invoices === 0 &&
          row.tickets === 0 &&
          row.paymentMails === 0,
        `${label}: ${row.captured} payments, ${row.allocations} allocations, ${row.invoices} invoices, ${row.tickets} tickets, ${row.paymentMails} mails`,
      );
    }
  }

  // Bank transactions
  const groups = new Map();
  for (const exp of expected.transactions) {
    const row = txByE2e.get(exp.endToEndId);
    const s = exp.scenario;
    if (!row) {
      record(s, 'transaction imported', false, exp.endToEndId);
      continue;
    }
    const options_ = exp.expect.oneOf ?? [exp.expect];
    const hit = options_.some(
      (o) => row.status === o.matchStatus && (row.reason ?? null) === (o.reviewReason ?? null),
    );
    record(
      s,
      'transaction status',
      hit,
      `${exp.endToEndId}: ${row.status}${row.reason ? `/${row.reason}` : ''}, expected ${options_.map((o) => (o.reviewReason ? `${o.matchStatus}/${o.reviewReason}` : o.matchStatus)).join(' or ')}`,
    );
    const matched = row.status === 'AUTO_MATCHED';
    record(
      s,
      'allocation consistent',
      matched
        ? row.allocations === 1 && row.allocatedCents === row.amount && row.payments === 1
        : row.allocations === 0 && row.payments === 0,
      `${exp.endToEndId}: ${row.allocations} allocations (${row.allocatedCents}), ${row.payments} payments, status ${row.status}`,
    );
    if (exp.group) {
      const list = groups.get(exp.group) ?? [];
      list.push(row);
      groups.set(exp.group, list);
    }
  }
  for (const [group, rows] of groups) {
    const auto = rows.filter((r) => r.status === 'AUTO_MATCHED').length;
    const over = rows.filter(
      (r) => r.status === 'NEEDS_REVIEW' && r.reason === 'OVERPAYMENT',
    ).length;
    record(
      'duplicate',
      'one pays, one is a Klaerfall',
      rows.length === 2 && auto === 1 && over === 1,
      `${group}: ${auto} auto matched, ${over} overpayment review`,
    );
  }

  // Global invariants
  const orders = snapshot.orders;
  record(
    'global',
    'no order paid twice',
    orders.every((o) => o.captured <= 1 && o.allocations <= 1),
    orders
      .filter((o) => o.captured > 1 || o.allocations > 1)
      .map((o) => o.orderNumber)
      .join(', '),
  );
  const sum = (list, f) => list.reduce((a, o) => a + f(o), 0);
  record(
    'global',
    'sum of amount_paid equals sum of payments',
    sum(orders, (o) => o.amountPaid) === sum(orders, (o) => o.capturedCents),
    `${sum(orders, (o) => o.amountPaid)} vs ${sum(orders, (o) => o.capturedCents)}`,
  );
  record(
    'global',
    'sum of payments equals sum of allocations',
    sum(orders, (o) => o.bankCapturedCents) === sum(orders, (o) => o.allocatedCents),
    `${sum(orders, (o) => o.bankCapturedCents)} vs ${sum(orders, (o) => o.allocatedCents)}`,
  );
  record(
    'global',
    'every transaction was matched (none UNMATCHED)',
    snapshot.transactions.every((t) => t.status !== 'UNMATCHED'),
    `${snapshot.transactions.filter((t) => t.status === 'UNMATCHED').length} UNMATCHED`,
  );
  record(
    'global',
    'all expected transactions were imported',
    snapshot.transactions.length === expected.transactions.length,
    `${snapshot.transactions.length} imported, ${expected.transactions.length} expected`,
  );
  record(
    'global',
    'no PAID order for a debit or an unrelated transfer',
    expected.orders
      .filter((o) => ['debit', 'unpaid', 'unknown'].includes(o.scenario))
      .every((o) => orderByNumber.get(o.orderNumber)?.status !== 'PAID'),
    'a debit / unknown-reference order is PAID',
  );
  if (snapshot.settings && snapshot.settings.toleranceCents !== expected.toleranceCents) {
    record(
      'global',
      'matching tolerance of the target equals the generator setting',
      false,
      `target ${snapshot.settings.toleranceCents} cents, expected.json ${expected.toleranceCents}`,
    );
  }

  const list = [...checks.values()];
  const failures = list.reduce((a, c) => a + c.failed, 0);
  return { ok: failures === 0, checks: list, failures };
}

/** Timings (ms) from the last `counts` poll. */
export function computeTimings(last, expectedPaid) {
  if (!last) return {};
  const span = (to) => (last.firstTx && to ? to - last.firstTx : null);
  const lastPaymentMs = span(last.lastPayment);
  return {
    importToLastPaymentMs: lastPaymentMs,
    importToLastInvoiceMs: span(last.lastInvoice),
    importToLastTicketMs: span(last.lastTicket),
    importToLastPaymentMailMs: span(last.lastPaymentMail),
    matchedPerSecond:
      lastPaymentMs && lastPaymentMs > 0
        ? Number((expectedPaid / (lastPaymentMs / 1000)).toFixed(2))
        : null,
  };
}

// ── execution ────────────────────────────────────────────────────────────────────────
function runShell(command, input, timeoutMs = 120_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`Command exited with ${code}: ${stderr.trim().slice(0, 400)}`));
      else resolvePromise({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (ms) => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.expected || !args['psql-cmd']) {
    console.log(
      'Usage: node scripts/load/verify-reconciliation.mjs --expected <file> --psql-cmd "<command reading SQL on stdin>" [--wait 600s] [--interval 5s] [--stable-polls 3] [--out file] [--logs-cmd "<cmd>"] [--skip-fulfillment]',
    );
    process.exit(2);
  }
  let expected;
  let waitMs;
  let intervalMs;
  try {
    expected = JSON.parse(readFileSync(resolve(String(args.expected)), 'utf8'));
    assertScope(expected);
    waitMs = parseDuration(args.wait, 600_000);
    intervalMs = parseDuration(args.interval, 5_000);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const psql = String(args['psql-cmd']);
  const stablePolls = Math.max(1, Number(args['stable-polls'] ?? 3));
  const fulfillment = !args['skip-fulfillment'];
  const query = async (names) => {
    const sql = [QUERIES.readOnly(), ...names.map((n) => QUERIES[n](expected))].join('\n');
    assertReadOnlySql(sql);
    const { stdout } = await runShell(psql, sql);
    return parseMarkerLines(stdout);
  };

  const t0 = Date.now();
  const timeline = [];
  let last = null;
  let lastKey = '';
  let stable = 0;
  let settled = false;
  const expectedTx = expected.transactions.length;
  const expectedPaid = expected.totals.ordersExpectedPaid;
  console.log(
    `Waiting for ${expectedTx} bank transactions of run ${expected.runId} (${expected.orders.length} orders, ${expectedPaid} expected PAID), up to ${fmtTime(waitMs)}`,
  );
  console.log(
    'elapsed  tx(U/A/M/N/I)        orders PAID/AWAIT  payments invoices tickets mails(queued/sent/failed)',
  );
  while (Date.now() - t0 <= waitMs) {
    let counts;
    try {
      counts = (await query(['counts'])).find((l) => l.kind === 'counts')?.data;
    } catch (e) {
      console.error(`poll failed: ${e.message}`);
    }
    if (counts) {
      last = counts;
      const n = (o, k) => Number(o?.[k] ?? 0);
      const txTotal = Object.values(counts.tx).reduce((a, b) => a + Number(b), 0);
      const mail = counts.mail;
      const row = {
        elapsedMs: Date.now() - t0,
        tx: counts.tx,
        orders: counts.orders,
        payments: Number(counts.payments),
        invoices: Number(counts.invoices),
        tickets: Number(counts.tickets),
        mail,
      };
      timeline.push(row);
      console.log(
        `${fmtTime(row.elapsedMs).padEnd(8)} ${[n(counts.tx, 'UNMATCHED'), n(counts.tx, 'AUTO_MATCHED'), n(counts.tx, 'MANUALLY_MATCHED'), n(counts.tx, 'NEEDS_REVIEW'), n(counts.tx, 'IGNORED')].join('/').padEnd(20)} ${`${n(counts.orders, 'PAID')}/${n(counts.orders, 'AWAITING_PAYMENT')}`.padEnd(18)} ${String(row.payments).padEnd(8)} ${String(row.invoices).padEnd(8)} ${String(row.tickets).padEnd(7)} ${n(mail, 'QUEUED') + n(mail, 'SENDING')}/${n(mail, 'SENT')}/${n(mail, 'FAILED')}`,
      );
      const key = JSON.stringify([
        counts.tx,
        counts.orders,
        row.payments,
        row.invoices,
        row.tickets,
        mail,
      ]);
      stable = key === lastKey ? stable + 1 : 0;
      lastKey = key;
      const imported = txTotal >= expectedTx && n(counts.tx, 'UNMATCHED') === 0;
      const paid = n(counts.orders, 'PAID');
      const downstream =
        !fulfillment || (row.invoices >= paid && Number(counts.paymentMails) >= paid);
      if (imported && stable >= stablePolls && (downstream || stable >= stablePolls * 4)) {
        settled = true;
        break;
      }
    }
    await sleep(intervalMs);
  }
  if (!settled)
    console.log('\nThe state did not settle within the wait time: evaluating what is there.');

  const lines = await query(['settings', 'transactions', 'orders']);
  const snapshot = {
    settings: lines.find((l) => l.kind === 'settings')?.data,
    transactions: lines.filter((l) => l.kind === 'tx').map((l) => l.data),
    orders: lines.filter((l) => l.kind === 'order').map((l) => l.data),
  };
  const result = evaluate(snapshot, expected, { fulfillment });
  const timings = computeTimings(last, expectedPaid);

  console.log('\nResult per scenario');
  const byScenario = new Map();
  for (const c of result.checks) {
    const e = byScenario.get(c.scenario) ?? { total: 0, failed: 0 };
    e.total += c.total;
    e.failed += c.failed;
    byScenario.set(c.scenario, e);
  }
  for (const [name, e] of byScenario)
    console.log(
      `  ${e.failed === 0 ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${e.total - e.failed}/${e.total} checks`,
    );
  for (const c of result.checks.filter((x) => x.failed > 0)) {
    console.log(`\n  FAIL [${c.scenario}] ${c.check}: ${c.failed} of ${c.total}`);
    for (const s of c.samples) console.log(`       ${s}`);
  }

  console.log('\nTimings (from the first imported bank transaction)');
  console.log(
    `  last payment booked      ${fmtTime(timings.importToLastPaymentMs)}   (${timings.matchedPerSecond ?? '-'} orders/s)`,
  );
  console.log(`  last invoice             ${fmtTime(timings.importToLastInvoiceMs)}`);
  console.log(`  last ticket issued       ${fmtTime(timings.importToLastTicketMs)}`);
  console.log(`  last payment e-mail      ${fmtTime(timings.importToLastPaymentMailMs)}`);

  let logs = null;
  if (args['logs-cmd']) {
    try {
      const { stdout, stderr } = await runShell(String(args['logs-cmd']), undefined, 120_000);
      logs = analyzeLogs(`${stdout}\n${stderr}`);
      console.log(
        `\nLogs: ${logs.lines} lines, ${logs.errors} error lines (level >= 50 / "error")`,
      );
      for (const t of logs.top) console.log(`  ${String(t.count).padStart(5)}x ${t.message}`);
    } catch (e) {
      console.log(`\nLogs could not be read: ${e.message}`);
    }
  }

  const ok = result.ok && settled;
  const summary = {
    ok,
    settled,
    runId: expected.runId,
    waitedMs: Date.now() - t0,
    expected: expected.totals,
    final: last,
    timings,
    checks: result.checks,
    failures: result.failures,
    logs,
    timeline,
  };
  if (args.out) writeFileSync(resolve(String(args.out)), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: ${result.failures} failed checks${settled ? '' : ', state not settled'}`,
  );
  console.log(
    `TIXV-SUMMARY ${JSON.stringify({ ok, failures: result.failures, settled, timings })}`,
  );
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
