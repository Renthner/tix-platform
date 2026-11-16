import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QUERIES,
  analyzeLogs,
  assertReadOnlySql,
  assertScope,
  computeTimings,
  evaluate,
  parseDuration,
  parseMarkerLines,
} from '../verify-reconciliation.mjs';

const expected = {
  runId: 'ABCDE',
  toleranceCents: 50,
  totals: { ordersExpectedPaid: 1 },
  orders: [
    {
      orderNumber: 'O-1',
      scenario: 'exact',
      status: 'PAID',
      amountPaidCents: 5000,
      capturedPayments: 1,
    },
    {
      orderNumber: 'O-2',
      scenario: 'over',
      status: 'AWAITING_PAYMENT',
      amountPaidCents: 0,
      capturedPayments: 0,
    },
  ],
  transactions: [
    {
      endToEndId: 'KTABCDE-00001',
      scenario: 'exact',
      expect: { matchStatus: 'AUTO_MATCHED', reviewReason: null },
    },
    {
      endToEndId: 'KTABCDE-00002',
      scenario: 'over',
      expect: { matchStatus: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' },
    },
  ],
};
const order = (o) => ({
  items: 1,
  captured: 0,
  capturedCents: 0,
  bankCapturedCents: 0,
  allocations: 0,
  allocatedCents: 0,
  invoices: 0,
  tickets: 0,
  paymentMails: 0,
  totalGross: 5000,
  ...o,
});
const paid = {
  orderNumber: 'O-1',
  status: 'PAID',
  amountPaid: 5000,
  captured: 1,
  capturedCents: 5000,
  bankCapturedCents: 5000,
  allocations: 1,
  allocatedCents: 5000,
  invoices: 1,
  tickets: 2,
  paymentMails: 1,
};
const good = () => ({
  settings: { toleranceCents: 50 },
  transactions: [
    {
      e2e: 'KTABCDE-00001',
      status: 'AUTO_MATCHED',
      reason: null,
      amount: 5000,
      allocations: 1,
      allocatedCents: 5000,
      payments: 1,
    },
    {
      e2e: 'KTABCDE-00002',
      status: 'NEEDS_REVIEW',
      reason: 'OVERPAYMENT',
      amount: 6000,
      allocations: 0,
      allocatedCents: 0,
      payments: 0,
    },
  ],
  orders: [order(paid), order({ orderNumber: 'O-2', status: 'AWAITING_PAYMENT', amountPaid: 0 })],
});

test('marker lines are found in arbitrary psql output', () => {
  const out =
    'SET\n TIXV:ignored-with-space\nTIXV:tx:{"a":1}\r\nTIXV:order:{"b":"x|y"}\nTIXV:tx:{broken\n(3 rows)\n';
  assert.deepEqual(parseMarkerLines(out), [
    { kind: 'tx', data: { a: 1 } },
    { kind: 'order', data: { b: 'x|y' } },
  ]);
});

test('durations', () => {
  assert.equal(parseDuration('600s'), 600_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration(undefined, 7), 7);
  assert.throws(() => parseDuration('soon'), /Invalid duration/);
});

test('a correct state passes, with and without the fulfilment checks', () => {
  assert.equal(evaluate(good(), expected).ok, true);
  const noWorker = good();
  noWorker.orders[0] = { ...noWorker.orders[0], invoices: 0, tickets: 0, paymentMails: 0 };
  assert.equal(evaluate(noWorker, expected).ok, false);
  assert.equal(evaluate(noWorker, expected, { fulfillment: false }).ok, true);
});

test('each kind of defect is reported', () => {
  const failing = (mutate) => {
    const s = good();
    mutate(s);
    return evaluate(s, expected)
      .checks.filter((c) => c.failed > 0)
      .map((c) => c.check);
  };
  assert.ok(failing((s) => (s.orders[0].status = 'AWAITING_PAYMENT')).includes('order status'));
  assert.ok(failing((s) => (s.orders[0].captured = 2)).includes('no order paid twice'));
  assert.ok(failing((s) => (s.orders[1].status = 'PAID')).includes('order status'));
  assert.ok(
    failing((s) => (s.transactions[0].status = 'UNMATCHED')).includes(
      'every transaction was matched (none UNMATCHED)',
    ),
  );
  assert.ok(
    failing((s) => (s.transactions[1].reason = 'UNDERPAYMENT')).includes('transaction status'),
  );
  assert.ok(
    failing((s) => (s.orders[0].amountPaid = 4000)).includes(
      'sum of amount_paid equals sum of payments',
    ),
  );
  assert.ok(failing((s) => (s.orders[0].invoices = 0)).includes('invoice issued'));
  assert.ok(failing((s) => s.transactions.pop()).includes('transaction imported'));
  assert.ok(
    failing((s) => (s.settings.toleranceCents = 0)).includes(
      'matching tolerance of the target equals the generator setting',
    ),
  );
});

test('a duplicate payment group needs exactly one payment and one review', () => {
  const oneOf = [
    { matchStatus: 'AUTO_MATCHED', reviewReason: null },
    { matchStatus: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' },
  ];
  const exp = {
    ...expected,
    orders: [
      {
        orderNumber: 'O-1',
        scenario: 'duplicate',
        status: 'PAID',
        amountPaidCents: 5000,
        capturedPayments: 1,
      },
    ],
    transactions: ['1', '2'].map((n) => ({
      endToEndId: `KTABCDE-0000${n}`,
      scenario: 'duplicate',
      group: 'duplicate:O-1',
      expect: { oneOf },
    })),
  };
  const snap = (a, b) => ({
    transactions: [
      { e2e: 'KTABCDE-00001', ...a },
      { e2e: 'KTABCDE-00002', ...b },
    ],
    orders: [order(paid)],
  });
  const auto = {
    status: 'AUTO_MATCHED',
    reason: null,
    amount: 5000,
    allocations: 1,
    allocatedCents: 5000,
    payments: 1,
  };
  const over = {
    status: 'NEEDS_REVIEW',
    reason: 'OVERPAYMENT',
    amount: 5000,
    allocations: 0,
    allocatedCents: 0,
    payments: 0,
  };
  assert.equal(evaluate(snap(auto, over), exp).ok, true);
  assert.equal(evaluate(snap(over, auto), exp).ok, true);
  assert.equal(evaluate(snap(auto, auto), exp).ok, false);
});

test('queries are read-only, scoped and keep user input out of the SQL', () => {
  assertScope(expected);
  assert.throws(() => assertScope({ runId: "A'; drop table orders;--", orders: [] }), /runId/);
  assert.throws(
    () => assertScope({ runId: 'ABCDE', orders: [{ orderNumber: "x'); delete from orders;--" }] }),
    /order number/,
  );
  const exp = { ...expected, orders: [{ orderNumber: 'O-1' }] };
  for (const [name, fn] of Object.entries(QUERIES)) {
    const sql = fn(exp);
    assertReadOnlySql(sql);
    if (name !== 'readOnly') assert.match(sql, /TIXV:/);
  }
  assert.throws(() => assertReadOnlySql('select 1; delete from orders'), /non-read-only/);
  assert.throws(() => assertReadOnlySql('update orders set status = 1'), /non-read-only/);
});

test('timings come from created_at timestamps relative to the first transaction', () => {
  const t = computeTimings(
    {
      firstTx: 1000,
      lastPayment: 11_000,
      lastInvoice: 21_000,
      lastTicket: null,
      lastPaymentMail: 31_000,
    },
    100,
  );
  assert.equal(t.importToLastPaymentMs, 10_000);
  assert.equal(t.matchedPerSecond, 10);
  assert.equal(t.importToLastInvoiceMs, 20_000);
  assert.equal(t.importToLastTicketMs, null);
  assert.deepEqual(computeTimings(null, 1), {});
});

test('log analysis counts pino level >= 50 and plain error lines', () => {
  const log = [
    '{"level":30,"msg":"fine"}',
    '{"level":50,"msg":"order-paid failed"}',
    '{"level":60,"msg":"order-paid failed"}',
    'worker  | {"level":50,"msg":"smtp down"}',
    '2026-11-16 ERROR something broke',
    'all good',
  ].join('\n');
  const r = analyzeLogs(log);
  assert.equal(r.lines, 6);
  assert.equal(r.errors, 4);
  assert.deepEqual(r.top[0], { message: 'order-paid failed', count: 2 });
});
