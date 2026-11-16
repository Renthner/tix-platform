import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EndpointStats,
  Histogram,
  checkDatabaseTarget,
  checkTarget,
  evaluateAssertions,
  findOverlaps,
  looksLikeToken,
  parseDuration,
  parsePrometheus,
  rampOffsets,
  redact,
  sliceUsers,
} from '../lib/stats.mjs';

test('histogram percentiles are within 5 % and merge exactly', () => {
  const a = new Histogram();
  const b = new Histogram();
  for (let i = 1; i <= 1000; i++) (i % 2 ? a : b).record(i);
  const merged = new Histogram().merge(a).merge(b);
  assert.equal(merged.n, 1000);
  for (const [p, exact] of [
    [50, 500],
    [95, 950],
    [99, 990],
  ]) {
    const got = merged.percentile(p);
    assert.ok(got >= exact * 0.99 && got <= exact * 1.06, `p${p}: ${got} vs ${exact}`);
  }
  assert.equal(merged.max, 1000);
  assert.equal(new Histogram().percentile(50), null);
  const round = Histogram.fromJSON(JSON.parse(JSON.stringify(merged)));
  assert.equal(round.percentile(95), merged.percentile(95));
});

test('endpoint stats count statuses, codes, 429 / 503 and merge', () => {
  const s = new EndpointStats();
  s.record('LOCK', 200, '', 10);
  s.record('LOCK', 409, 'SEAT_LOCKED', 20);
  s.record('LOCK', 429, 'RATE_LIMITED', 5);
  const t = new EndpointStats();
  t.record('LOCK', 503, 'BUSY', 30);
  t.record('LOCK', 0, 'TIMEOUT', 30000);
  s.merge(EndpointStats.fromJSON(JSON.parse(JSON.stringify(t.toJSON()))));
  const sum = s.summary(10);
  assert.equal(sum.requests, 5);
  assert.equal(sum.rateLimited429, 1);
  assert.equal(sum.unavailable503, 1);
  assert.equal(sum.failures5xxOrNetwork, 2);
  assert.equal(sum.endpoints.LOCK.codes['409:SEAT_LOCKED'], 1);
  assert.equal(sum.requestsPerSecond, 0.5);
});

test('ramp offsets', () => {
  const lin = rampOffsets(4, 1000, 'linear');
  assert.deepEqual(lin, [0, 250, 500, 750]);
  assert.deepEqual(rampOffsets(3, 1000, 'spike'), [0, 0, 0]);
  const step = rampOffsets(10, 1000, 'step');
  assert.equal(step[0], 0);
  assert.equal(step[9], 800);
  assert.deepEqual(rampOffsets(2, 0), [0, 0]);
  assert.throws(() => rampOffsets(2, 1000, 'zigzag'));
});

test('sliceUsers covers everybody once', () => {
  const s = sliceUsers(1001, 4);
  assert.equal(
    s.reduce((n, x) => n + x.count, 0),
    1001,
  );
  assert.equal(s[0].start, 0);
  assert.equal(s[1].start, s[0].count);
  assert.deepEqual(
    sliceUsers(2, 8).map((x) => x.count),
    [1, 1],
  );
});

test('findOverlaps flags two sessions on the same seat, ignores sequential holds and same session', () => {
  const iv = (seat, sid, from, to, extra = {}) => ({ seat, sid, from, to, ...extra });
  const certain = (list) => findOverlaps(list).certain.length;
  assert.equal(certain([iv('s1', 'a', 0, 100), iv('s1', 'b', 100, 200)]), 0);
  assert.equal(certain([iv('s1', 'a', 0, 100), iv('s1', 'b', 99, 200)]), 1);
  assert.equal(certain([iv('s1', 'a', 0, 100), iv('s1', 'a', 50, 150)]), 0);
  assert.equal(certain([iv('s1', 'a', 0, 100), iv('s2', 'b', 0, 100)]), 0);
  // a release with an unknown outcome is only indeterminate (see overlaps.test.mjs)
  const unknown = findOverlaps([
    iv('s1', 'a', 0, 100, { toUnknown: true }),
    iv('s1', 'b', 500, 600),
  ]);
  assert.equal(unknown.certain.length, 0);
  assert.equal(unknown.indeterminate.length, 1);
});

test('target guard refuses the regular stack and bad input', () => {
  assert.equal(checkTarget(undefined).ok, false);
  assert.equal(checkTarget('ftp://x').ok, false);
  assert.equal(checkTarget('not a url').ok, false);
  assert.equal(checkTarget('http://localhost:8080').ok, false);
  assert.equal(checkTarget('http://127.0.0.1:3000/').ok, false);
  assert.equal(checkTarget('http://localhost:18210').ok, true);
  assert.equal(checkTarget('https://shop.example.org').ok, true);
  assert.equal(checkTarget('https://shop.example.org:8080').ok, true);
});

test('database target guard refuses private / LAN hosts unless allowed', () => {
  const url = (host) => `postgres://u:p@${host}:5432/db`;
  for (const host of [
    '192.168.1.20',
    '10.0.0.5',
    '172.16.4.1',
    '169.254.1.1',
    'db.lan',
    '[fd00::1]',
  ]) {
    assert.equal(checkDatabaseTarget(url(host)).ok, false, host);
    assert.equal(checkDatabaseTarget(url(host), { allowPrivate: true }).ok, true, host);
  }
  for (const host of ['127.0.0.1', 'localhost', 'db.example.org', '8.8.8.8', '172.32.0.1']) {
    assert.equal(checkDatabaseTarget(url(host)).ok, true, host);
  }
  assert.equal(checkDatabaseTarget('http://x').ok, false);
  assert.equal(checkDatabaseTarget('nonsense').ok, false);
});

test('token shape, redaction, durations, prometheus', () => {
  assert.equal(looksLikeToken('x'.repeat(43)), true);
  assert.equal(looksLikeToken('short'), false);
  assert.equal(looksLikeToken('has space ' + 'x'.repeat(40)), false);
  assert.equal(redact('boom SECRET boom', 'SECRET'), 'boom [token] boom');
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2m'), 120_000);
  assert.equal(parseDuration('45'), 45_000);
  assert.equal(parseDuration(undefined, 7), 7);
  assert.throws(() => parseDuration('soon'));
  const p = parsePrometheus('# HELP x\nx 1\ny{a="b c"} 2.5\nz NaN\n');
  assert.deepEqual(p, { x: 1, 'y{a="b c"}': 2.5 });
});

test('assertions: pass and each failure mode', () => {
  const summary = (over = {}) => ({
    requests: 1000,
    failures5xxOrNetwork: 0,
    failureRate: 0,
    rateLimited429: 0,
    rate429: 0,
    unavailable503: 0,
    rate503: 0,
    ...over,
  });
  const limits = { maxFailureRate: 0.01, max429Rate: 0.001, max503Rate: 0.02, maxFanoutP95Ms: 100 };
  const ledger = { intervals: 10, hotSeats: 5, hotWon: 5, hotLost: 90, hotContenders: 100 };
  const rt = { connected: 3, samples: 9, p50: 5, p95: 20, p99: 30 };
  const ok = evaluateAssertions({ summary: summary(), overlaps: [], limits, ledger, rt });
  assert.ok(ok.every((c) => c.ok));
  const bad = evaluateAssertions({
    summary: summary({ failureRate: 0.05, rate429: 0.5, rate503: 0.5 }),
    overlaps: [{ seat: 's' }],
    limits,
    ledger: { ...ledger, hotWon: 0 },
    rt: { ...rt, p95: 500 },
  });
  assert.equal(bad.filter((c) => !c.ok).length, 6);
});
