import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EndpointStats,
  classifyEnter,
  diagnosisHints,
  evaluateAssertions,
  findOverlaps,
  foldMetricSample,
} from '../lib/stats.mjs';

const iv = (seat, sid, from, to, extra = {}) => ({ seat, sid, from, to, ...extra });

test('certain overlap is detected and carries details', () => {
  const { certain, indeterminate } = findOverlaps([
    iv('s1', 'a', 1000, 5000, { releaseStatus: 200 }),
    iv('s1', 'b', 2000, 3000, { releaseStatus: 200 }),
  ]);
  assert.equal(certain.length, 1);
  assert.equal(indeterminate.length, 0);
  const d = certain[0].details;
  assert.equal(d.seat, 's1');
  assert.equal(d.kind, 'certain');
  assert.deepEqual([d.a.sid, d.b.sid], ['a', 'b']);
  assert.equal(d.a.from, new Date(1000).toISOString());
  assert.equal(d.b.to, new Date(3000).toISOString());
  assert.equal(d.a.releaseUnknown, false);
});

test('a release that timed out never produces a certain overlap, only an indeterminate one', () => {
  // a released (sent at 100) but the request timed out; b locked the seat later (legitimately)
  const { certain, indeterminate } = findOverlaps([
    iv('s1', 'a', 0, 100, { toUnknown: true, releaseStatus: 0, releaseCode: 'TIMEOUT' }),
    iv('s1', 'b', 500, 600, { releaseStatus: 200 }),
  ]);
  assert.equal(certain.length, 0);
  assert.equal(indeterminate.length, 1);
  const d = indeterminate[0].details;
  assert.equal(d.a.releaseUnknown, true);
  assert.equal(d.b.releaseUnknown, false);
  assert.equal(d.a.releaseStatus, 0);
  assert.equal(d.a.releaseCode, 'TIMEOUT');
  assert.equal(d.a.from, new Date(0).toISOString());
  assert.equal(d.a.to, new Date(100).toISOString());
});

test('sequential holds, the same session and different seats stay clean', () => {
  const r = findOverlaps([
    iv('s1', 'a', 0, 100),
    iv('s1', 'b', 100, 200),
    iv('s1', 'a', 300, 400, { toUnknown: true }),
    iv('s2', 'x', 0, 100, { toUnknown: true }),
    iv('s2', 'x', 50, 150),
  ]);
  assert.equal(r.certain.length, 0);
  assert.equal(r.indeterminate.length, 0);
});

test('certain pair is not duplicated as indeterminate', () => {
  const r = findOverlaps([iv('s1', 'a', 0, 100, { toUnknown: true }), iv('s1', 'b', 50, 200)]);
  assert.equal(r.certain.length, 1);
  assert.equal(r.indeterminate.length, 0);
});

test('assertions: certain overlap fails, indeterminate only warns', () => {
  const summary = {
    requests: 10,
    failures5xxOrNetwork: 0,
    failureRate: 0,
    rateLimited429: 0,
    rate429: 0,
    unavailable503: 0,
    rate503: 0,
  };
  const limits = { maxFailureRate: 0.01, max429Rate: 0.001, max503Rate: 0.02, maxFanoutP95Ms: 100 };
  const ledger = { intervals: 2 };
  const warn = evaluateAssertions({
    summary,
    overlaps: [],
    indeterminateOverlaps: [{ seat: 's1' }],
    limits,
    ledger,
  });
  assert.ok(warn.every((c) => c.ok));
  assert.ok(warn.some((c) => c.warn && /indeterminate/.test(c.title)));
  const fail = evaluateAssertions({ summary, overlaps: [{ seat: 's1' }], limits, ledger });
  assert.equal(fail.filter((c) => !c.ok).length, 1);
});

test('null-safe failure marking, timeouts and bytes in the summary', () => {
  const s = new EndpointStats();
  s.record('A', 200, '', 10, 100);
  s.record('A', 0, 'TIMEOUT', 30000, 0);
  s.record('B', 200, '', 5, 50);
  s.markFailure('B', 'BAD_BODY');
  const sum = new EndpointStats().merge(s).summary(10);
  assert.equal(sum.requests, 3);
  assert.equal(sum.timeouts, 1);
  assert.deepEqual(sum.timeoutsByEndpoint, { A: 1 });
  assert.equal(sum.failures5xxOrNetwork, 2);
  assert.equal(sum.bytesReceived, 150);
  assert.equal(sum.bytesPerSecond, 15);
  const round = EndpointStats.fromJSON(JSON.parse(JSON.stringify(s.toJSON()))).summary(10);
  assert.equal(round.bytesReceived, 150);
});

test('metric peaks are kept per pid and diagnosis hints follow the data', () => {
  const peaks = {};
  const sample = (waiting, p99, pid = 1) => ({
    [`tix_db_pool_connections{pid="${pid}",state="total"}`]: 20,
    [`tix_db_pool_connections{pid="${pid}",state="idle"}`]: 5,
    [`tix_db_pool_connections{pid="${pid}",state="waiting"}`]: waiting,
    [`tix_event_loop_lag_seconds{pid="${pid}",quantile="0.99"}`]: p99,
  });
  foldMetricSample(peaks, sample(0, 0.01));
  foldMetricSample(peaks, sample(3, 0.02));
  foldMetricSample(peaks, sample(0, 0.5, 2));
  assert.equal(peaks['tix_db_pool_connections{pid="1",state="waiting"}'], 3);
  assert.equal(peaks['tix_db_pool_in_use{pid="1"}'], 15);
  assert.equal(peaks['tix_event_loop_lag_seconds{pid="2",quantile="0.99"}'], 0.5);

  const summary = { timeoutRate: 0.05, timeouts: 50, requests: 1000 };
  const both = diagnosisHints({ summary, peaks, scrapes: { ok: 3, failed: 0 } }).join('\n');
  assert.match(both, /DB pool/);
  assert.match(both, /event loop/);
  const calm = {};
  foldMetricSample(calm, sample(0, 0.01));
  const none = diagnosisHints({ summary, peaks: calm, scrapes: { ok: 3, failed: 0 } }).join('\n');
  assert.match(none, /not CPU\/DB\/event-loop bound/);
  assert.match(none, /Cloudflare\/Traefik\/uplink/);
  assert.deepEqual(
    diagnosisHints({ summary: { ...summary, timeoutRate: 0.005 }, peaks, scrapes: { ok: 1 } }),
    [],
  );
  const blind = diagnosisHints({ summary, peaks: {}, scrapes: { ok: 0, failed: 4 } }).join('\n');
  assert.match(blind, /no server metrics could be sampled/);
});

test('ENTER classification: only a real waiting room status counts as queued', () => {
  const r = (status, body, code = '') => ({ status, body, code });
  assert.equal(classifyEnter(r(200, { status: 'GRANTED' })), 'granted');
  for (const st of ['QUEUED', 'LOBBY', 'NOT_STARTED', 'ADMITTED'])
    assert.equal(classifyEnter(r(200, { status: st })), 'queued');
  assert.equal(classifyEnter(r(0, null, 'TIMEOUT')), 'timeout');
  assert.equal(classifyEnter(r(0, null, 'NETWORK:ECONNRESET')), 'network');
  assert.equal(classifyEnter(r(200, null, 'TIMEOUT')), 'body_timeout');
  assert.equal(classifyEnter(r(503, { error: {} })), 'other');
  assert.equal(classifyEnter(r(200, null)), 'other');
});
