import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Diagnostics,
  classifyNetworkError,
  cpuPercent,
  cpuTotals,
  diagnoseDiagnostics,
  pickSafeHeaders,
  sanitizeBody,
  summarizeCpu,
  summarizeLoopLag,
} from '../lib/diag.mjs';

const T0 = 1_000_000;
const obs = (d, o) =>
  d.observe({
    label: 'LOCK_HOT',
    method: 'POST',
    path: '/api/events/x/seats?a=1',
    status: 200,
    ms: 10,
    wallEnd: T0 + 1000,
    headers: {},
    text: '',
    ...o,
  });

test('samples are capped per endpoint:status, skip 2xx / 304 / 409 and strip the query', () => {
  const d = new Diagnostics(T0);
  for (let i = 0; i < 10; i++) obs(d, { status: 405, text: 'nope' });
  obs(d, { status: 409 });
  obs(d, { status: 204 });
  obs(d, { status: 304 });
  obs(d, { status: 504, label: 'CART' });
  const s = d.errorSamples();
  assert.equal(s.filter((x) => x.status === 405).length, 3);
  assert.equal(s.filter((x) => x.status === 504).length, 1);
  assert.equal(s.length, 4);
  assert.equal(s[0].path, '/api/events/x/seats');
});

test('headers: only the safe subset, no cookies or secrets; bodies one line, redacted', () => {
  const h = pickSafeHeaders(
    new Headers({
      server: 'cloudflare',
      'set-cookie': 'tix_sid=abc',
      authorization: 'Bearer x',
      'x-tix-loadtest': 'SECRET',
      'cf-ray': 'abc-FRA',
      'x-traefik-thing': 'y',
      location: '/login?token=SECRET',
    }),
    'SECRET',
  );
  assert.deepEqual(Object.keys(h).sort(), ['cf-ray', 'location', 'server', 'x-traefik-thing']);
  assert.equal(h.location, '/login');
  const b = sanitizeBody(`a\u0000b\r\nSECRET${'x'.repeat(300)}`, 'SECRET');
  assert.ok(b.length <= 210);
  assert.ok(!/[\u0000-\u001f]/.test(b));
  assert.ok(!b.includes('SECRET'));
  assert.equal(sanitizeBody(`${'y'.repeat(500)}`).length, 200);
});

test('network causes are grouped and harness aborts are told apart', () => {
  const abort = new DOMException('timed out', 'TimeoutError');
  assert.deepEqual(classifyNetworkError(abort), { cause: 'TimeoutError', kind: 'harness-timeout' });
  const undici = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
  });
  assert.deepEqual(classifyNetworkError(undici), {
    cause: 'UND_ERR_HEADERS_TIMEOUT',
    kind: 'connection',
  });
  const agg = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(
      new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' })]),
      {},
    ),
  });
  assert.equal(classifyNetworkError(agg).cause, 'ECONNREFUSED');
  const d = new Diagnostics(T0);
  obs(d, { status: 0, err: abort, code: 'TIMEOUT' });
  obs(d, { status: 0, err: undici, code: 'NETWORK:x', label: 'PAGE_HOME' });
  obs(d, { status: 0, err: undici, code: 'NETWORK:x', label: 'PAGE_HOME' });
  const n = d.networkErrorCauses();
  assert.equal(n.harnessTimeouts, 1);
  assert.equal(n.connectionErrors, 2);
  assert.equal(n.causes.UND_ERR_HEADERS_TIMEOUT.byEndpoint.PAGE_HOME, 2);
});

test('Cloudflare indicator counts cf-ray / server and survives merge + JSON', () => {
  const a = new Diagnostics(T0);
  obs(a, { headers: { 'cf-ray': '1-FRA' } });
  obs(a, { headers: { server: 'cloudflare' } });
  obs(a, { headers: { server: 'cloudflare', 'cf-ray': '2' } });
  obs(a, { headers: {} });
  const b = new Diagnostics(T0);
  obs(b, { headers: { server: 'Caddy' } });
  b.noteAddress('192.168.1.5');
  b.noteAddress('192.168.1.5');
  a.merge(Diagnostics.fromJSON(JSON.parse(JSON.stringify(b.toJSON()))));
  const p = a.pathIndicator();
  assert.equal(p.responses, 5);
  assert.equal(p.cloudflare, 3);
  assert.equal(p.cfRay, 2);
  assert.equal(p.serverCloudflare, 2);
  assert.deepEqual(p.remoteAddresses, [{ address: '192.168.1.5', connections: 2 }]);
  assert.ok(diagnoseDiagnostics({ diag: a }).some((l) => /through Cloudflare/.test(l)));
});

test('timeline buckets per 10 s with errors, timeouts, p95 and active shoppers', () => {
  const d = new Diagnostics(T0);
  obs(d, { wallEnd: T0 + 1000, ms: 100 });
  obs(d, { wallEnd: T0 + 9000, status: 409 }); // not an error
  obs(d, { wallEnd: T0 + 25_000, status: 500, ms: 300 });
  obs(d, {
    wallEnd: T0 + 26_000,
    status: 0,
    code: 'TIMEOUT',
    err: new DOMException('t', 'TimeoutError'),
  });
  d.noteActive(40, T0 + 2000);
  d.noteActive(10, T0 + 3000);
  const t = d.timeline();
  assert.equal(t.length, 3);
  assert.deepEqual([t[0].requests, t[0].errors, t[0].activeShoppers], [2, 0, 40]);
  assert.deepEqual([t[1].requests, t[1].p95Ms], [0, null]);
  assert.deepEqual([t[2].requests, t[2].errors, t[2].timeouts], [2, 2, 1]);
});

test('foreign 405 / 504 are flagged, app bodies are not', () => {
  const d = new Diagnostics(T0);
  obs(d, {
    status: 405,
    headers: { server: 'Microsoft-IIS' },
    text: '<html>Method Not Allowed</html>',
  });
  obs(d, { status: 504, label: 'CART', text: '{"error":{"code":"X","message":"m"}}' });
  const lines = diagnoseDiagnostics({ diag: d });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /status 405 was not produced by the TIX app/);
  assert.match(lines[0], /server: Microsoft-IIS/);
});

test('generator CPU diagnosis thresholds', () => {
  const a = cpuTotals([{ times: { user: 50, sys: 0, idle: 50 } }]);
  const b = cpuTotals([{ times: { user: 140, sys: 0, idle: 60 } }]);
  assert.equal(Math.round(cpuPercent(a, b)), 90);
  assert.equal(cpuPercent(a, a), null);
  assert.equal(summarizeCpu([40, 85]).saturated, false);
  const hot = summarizeCpu([40, 90, null]);
  assert.equal(hot.saturated, true);
  assert.equal(hot.avgPercent, 65);
  const d = new Diagnostics(T0);
  assert.ok(
    diagnoseDiagnostics({ diag: d, generator: { cpu: hot } }).some((l) =>
      l.includes('generator CPU is saturated: results are limited by the load generator'),
    ),
  );
  const lag = summarizeLoopLag([{ peakP99Ms: 50 }, { peakP99Ms: 400 }]);
  assert.equal(lag.saturated, true);
  assert.equal(
    diagnoseDiagnostics({ diag: d, generator: { cpu: { saturated: false }, loopLag: lag } }).length,
    1,
  );
});
