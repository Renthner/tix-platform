import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MIX,
  FUZZY_VARIANTS,
  apportion,
  buildCamt053,
  buildCsv,
  buildMt940,
  buildReference,
  buildStatement,
  classifyDelta,
  extractReference,
  fuzzReference,
  generate,
  germanIban,
  isValidIban,
  isValidReference,
  mt940Chunks,
  parseCsvRows,
  parseMix,
  parseOrdersCsv,
  payerAccount,
  planStatement,
  scenarioCounts,
} from '../bank-statement.mjs';

const orders = (n, { names = true } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    reference: buildReference('TIX', 2026, String(100000 + i)),
    amountCents: 2500 + i * 130,
    currency: 'EUR',
    payerName: names ? `Anna Beispiel${i}` : '',
    orderNumber: `O-${String(i).padStart(5, '0')}`,
  }));

test('references carry a valid Luhn digit and IBANs valid check digits', () => {
  const ref = buildReference('TIX', 2026, '008492');
  assert.ok(isValidReference(ref));
  assert.ok(!isValidReference(ref.slice(0, -1) + ((Number(ref.slice(-1)) + 1) % 10)));
  assert.ok(isValidIban('DE89370400440532013000'));
  assert.ok(!isValidIban('DE89370400440532013001'));
  for (let i = 0; i < 50; i += 1) {
    const acc = payerAccount(7, `p${i}`);
    assert.ok(isValidIban(acc.iban), acc.iban);
  }
  assert.ok(isValidIban(germanIban('37040044', 532013000)));
});

test('payer accounts are deterministic per seed and key', () => {
  assert.deepEqual(payerAccount(1, 'a'), payerAccount(1, 'a'));
  assert.notDeepEqual(payerAccount(1, 'a'), payerAccount(2, 'a'));
});

test('every fuzzy mutation stays matchable by the tolerant reference regex', () => {
  for (let n = 0; n < 400; n += 1) {
    const ref = buildReference('TIX', 2026, String(100000 + n * 37));
    for (const variant of FUZZY_VARIANTS) {
      const text = `Ticketbestellung ${fuzzReference(ref, variant)}`;
      const found = extractReference(text, 'TIX');
      assert.equal(found[0]?.reference, ref, `${variant}: ${text}`);
      assert.ok(found[0].checksumValid);
    }
  }
  // formerly a trap (fixed): a hyphen-less reference followed by a word or id is read correctly
  const ref = buildReference('TIX', 2026, '100000');
  for (const tail of [' Danke', 'Danke', ' OL-99', ' D4711000123']) {
    assert.equal(
      extractReference(`${fuzzReference(ref, 'no-hyphens')}${tail}`, 'TIX')[0]?.reference,
      ref,
      tail,
    );
  }
});

test('mix parsing and largest-remainder rounding always give exactly N', () => {
  assert.equal(parseMix('exact=90,fuzzy=10').exact, 90);
  assert.throws(() => parseMix('exact=90,bogus=1'), /Unknown mix/);
  assert.throws(() => parseMix('exact=90,fuzzy=20'), /more than 100/);
  assert.deepEqual(apportion(10, [1, 1, 1]), [4, 3, 3]);
  for (const total of [1, 7, 33, 60, 100, 333, 1000]) {
    const counts = scenarioCounts(total, DEFAULT_MIX);
    assert.equal(
      Object.values(counts).reduce((a, b) => a + b, 0),
      total,
    );
    if (total >= 10)
      for (const [k, v] of Object.entries(counts))
        if (k !== 'unpaid') assert.ok(v >= 1, `${k} at ${total}`);
  }
  assert.equal(scenarioCounts(100, DEFAULT_MIX).exact, 82);
});

test('the plan is deterministic for a seed and differs between seeds', () => {
  const a = planStatement(orders(80), { seed: 3, date: '2026-11-16' });
  const b = planStatement(orders(80), { seed: 3, date: '2026-11-16' });
  const c = planStatement(orders(80), { seed: 4, date: '2026-11-16' });
  assert.deepEqual(a.entries, b.entries);
  assert.notDeepEqual(a.entries, c.entries);
  assert.equal(a.runId, b.runId);
  assert.ok(!a.runId.includes('TIX'));
  assert.equal(new Set(a.entries.map((e) => e.endToEndId)).size, a.entries.length);
  assert.ok(
    a.entries.every(
      (e) =>
        e.endToEndId.length <= 35 &&
        !/TIX/i.test(e.endToEndId) &&
        /^[^OQDILSBZ]/.test(e.endToEndId),
    ),
  );
});

test('--limit and --split-files; the two payments of a duplicate stay in one file', () => {
  const plan = planStatement(orders(200), { seed: 2, limit: 100, splitFiles: 3 });
  assert.equal(plan.orders.length, 100);
  const dup = plan.entries.filter((e) => e.scenario === 'duplicate');
  assert.equal(dup.length, 2);
  assert.equal(dup[0].file, dup[1].file);
  for (let f = 0; f < 3; f += 1) assert.ok(plan.entries.some((e) => e.file === f));
});

test('classification follows the engine: tolerance on the delta', () => {
  assert.deepEqual(classifyDelta(0, 50), { matchStatus: 'AUTO_MATCHED', reviewReason: null });
  assert.equal(classifyDelta(-50, 50).matchStatus, 'AUTO_MATCHED');
  assert.equal(classifyDelta(50, 50).matchStatus, 'AUTO_MATCHED');
  assert.equal(classifyDelta(-51, 50).reviewReason, 'UNDERPAYMENT');
  assert.equal(classifyDelta(51, 50).reviewReason, 'OVERPAYMENT');
  assert.equal(classifyDelta(-1, 0).reviewReason, 'UNDERPAYMENT');
});

test('the expectation covers every order and the totals add up', () => {
  const exp = generate(orders(100), { seed: 9, date: '2026-11-16', toleranceCents: 50 }).expected;
  assert.equal(exp.orders.length, 100);
  assert.equal(exp.totals.ordersExpectedPaid + exp.totals.ordersExpectedOpen, 100);
  assert.equal(exp.totals.credits + exp.totals.debits, exp.transactions.length);
  assert.equal(exp.scenarios.exact.orders, 82);
  assert.ok(exp.scenarios.underWithin.expectedOrderStatus.every((s) => s === 'PAID'));
  assert.ok(exp.scenarios.underBeyond.expectedOrderStatus.every((s) => s === 'AWAITING_PAYMENT'));
  assert.ok(exp.scenarios.debit.expectedOrderStatus.every((s) => s === 'AWAITING_PAYMENT'));
  const dupOrder = exp.orders.find((o) => o.scenario === 'duplicate');
  assert.equal(dupOrder.capturedPayments, 1);
  assert.deepEqual(
    exp.transactions.filter((t) => t.group).map((t) => t.group),
    [`duplicate:${dupOrder.orderNumber}`, `duplicate:${dupOrder.orderNumber}`],
  );
});

test('a zero tolerance turns "underpaid within tolerance" into an UNDERPAYMENT review', () => {
  const exp = generate(orders(100), { seed: 9, toleranceCents: 0 }).expected;
  const t = exp.transactions.filter((x) => x.scenario === 'underWithin');
  assert.ok(t.length > 0 && t.every((x) => x.expect.reviewReason === 'UNDERPAYMENT'));
});

test('a nameless payer cannot be matched by name', () => {
  const exp = generate(orders(100, { names: false }), { seed: 1 }).expected;
  const t = exp.transactions.find((x) => x.scenario === 'nameOnly');
  assert.ok(['NAME_MATCH_ONLY', 'NO_REFERENCE'].includes(t.expect.reviewReason));
});

test('camt.053 output is well-formed and complete', () => {
  const plan = planStatement(orders(40), { seed: 1, date: '2026-11-16' });
  const xml = buildStatement(plan, 'camt053', 0, { accountIban: 'DE89 3704 0044 0532 0130 00' });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.equal((xml.match(/<Ntry>/g) ?? []).length, plan.entries.length);
  assert.equal((xml.match(/<\/Ntry>/g) ?? []).length, plan.entries.length);
  assert.equal(
    (xml.match(/<CdtDbtInd>DBIT<\/CdtDbtInd>/g) ?? []).length,
    plan.entries.filter((e) => e.direction === 'DBIT').length,
  );
  assert.ok(xml.includes('<IBAN>DE89370400440532013000</IBAN>'));
  assert.throws(
    () => buildStatement(plan, 'camt053', 0, { accountIban: 'DE89370400440532013001' }),
    /not a valid IBAN/,
  );
  // every element that is opened is closed (the integration test parses with the real parser)
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3] === '/') continue;
    if (m[1] === '') stack.push(m[2]);
    else assert.equal(stack.pop(), m[2]);
  }
  assert.equal(stack.length, 0);
});

test('XML special characters in names and texts are escaped', () => {
  const o = orders(5);
  o[0].payerName = 'Smith & <Sons> "Ltd"';
  const plan = planStatement(o, { seed: 1, mix: parseMix('nameOnly=100') });
  const xml = buildCamt053(plan.entries, {
    accountIban: 'DE89370400440532013000',
    date: '2026-11-16',
    statementId: 'X',
  });
  assert.ok(!xml.includes('<Sons>'));
  assert.ok(xml.includes('Smith &amp; &lt;Sons&gt; &quot;Ltd&quot;'));
});

test('CSV escaping: separators, quotes and line breaks survive a round trip', () => {
  assert.deepEqual(parseCsvRows('a,b\n"x, y","say ""hi"""\n"two\nlines",z\n'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['two\nlines', 'z'],
  ]);
  const o = orders(3);
  o[0].payerName = 'Meier; Anna "Ä"';
  const plan = planStatement(o, { seed: 1, mix: parseMix('nameOnly=100') });
  const csv = buildCsv(plan.entries, { accountIban: 'DE89370400440532013000' });
  assert.ok(csv.includes('"Meier; Anna ""Ä"""'));
  assert.ok(csv.split('\r\n')[0].startsWith('Buchungstag;Valuta;'));
});

test('the orders CSV parser accepts quoted names and rejects bad rows', () => {
  const ref = buildReference('TIX', 2026, '123456');
  const head = 'reference,amount_cents,currency,payer_name,order_number';
  const parsed = parseOrdersCsv(`${head}\n${ref},4990,EUR,"Müller, Anna",O-1\n`);
  assert.equal(parsed[0].payerName, 'Müller, Anna');
  assert.equal(parsed[0].amountCents, 4990);
  assert.throws(() => parseOrdersCsv('reference,amount_cents\n'), /lacks the columns/);
  assert.throws(
    () => parseOrdersCsv(`${head}\nTIX-2026-123456-0,1,EUR,A,O-1\n`),
    /valid payment reference/,
  );
  assert.throws(() => parseOrdersCsv(`${head}\n${ref},0,EUR,A,O-1\n`), /positive integer/);
});

test('MT940 sub-fields are at most 27 characters and never end with a space', () => {
  const samples = [
    'EREF+LTABCDE-00001SVWZ+TIX-2026-100000-1 Ticketbestellung',
    'a '.repeat(40).trim(),
    'x'.repeat(60),
  ];
  for (const text of samples) {
    const chunks = mt940Chunks(text);
    assert.equal(chunks.join(''), text);
    for (const c of chunks) {
      assert.ok(c.length <= 27 && c.length > 0);
      assert.ok(!c.endsWith(' '), JSON.stringify(c));
    }
  }
  const plan = planStatement(orders(30), { seed: 1, date: '2026-11-16' });
  const mt = buildMt940(plan.entries, {
    accountIban: 'DE89370400440532013000',
    date: '2026-11-16',
    statementId: 'S',
  });
  assert.equal((mt.match(/^:61:/gm) ?? []).length, plan.entries.length);
  assert.ok(mt.trimEnd().endsWith('-'));
});
