// Bounded concurrency per web process and request class, queueing, BUSY answers, counters.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { resolveEnv } from '../env.mjs';
import { classifyRequest, createProxyServer, parseListenCounters } from '../proxy.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) =>
  new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const clientAgent = new http.Agent({ keepAlive: false, maxSockets: 2000 });

function request(port, { path = '/', headers = {}, method = 'GET', agent = clientAgent } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
          ms: Date.now() - t0,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Upstream that answers after `delayFor(url)` ms and tracks the concurrently running requests per
 * class (by the path prefix used in the tests) and the open connections.
 */
async function rig({ delayFor = () => 10, ...proxyCfg } = {}) {
  const running = { page: 0, api: 0, static: 0 };
  const peak = { page: 0, api: 0, static: 0 };
  const seen = [];
  let conns = 0;
  let peakConns = 0;
  const up = http.createServer((req, res) => {
    seen.push(req.url);
    const cls = classifyRequest(req.method, req.url);
    running[cls] += 1;
    peak[cls] = Math.max(peak[cls], running[cls]);
    setTimeout(() => {
      running[cls] -= 1;
      res.end('ok');
    }, delayFor(req.url));
  });
  up.on('connection', (s) => {
    conns += 1;
    peakConns = Math.max(peakConns, conns);
    s.on('close', () => (conns -= 1));
  });
  const upPort = await listen(up);
  const proxy = createProxyServer({
    trustedProxies: '',
    upstreamHost: '127.0.0.1',
    webPort: upPort,
    realtimePort: upPort,
    getMode: () => null,
    maxConnsPerIp: 0,
    ...proxyCfg,
  });
  const port = await listen(proxy.server);
  return {
    port,
    proxy,
    peak,
    seen,
    peakConns: () => peakConns,
    stats: () => proxy.stats().children[0].classes,
    async close() {
      proxy.server.closeAllConnections?.();
      await proxy.close(100);
      up.closeAllConnections?.();
      up.close();
    },
  };
}

test('classification: static, api and page', () => {
  const table = [
    ['GET', '/', 'page'],
    ['GET', '/de/events/foo', 'page'],
    ['GET', '/de/events/foo/', 'page'],
    ['GET', '/de/events/foo?x=1.png', 'page'],
    ['POST', '/de/checkout', 'page'],
    ['GET', '/_next/static/chunks/a.js', 'static'],
    ['GET', '/_next/static/chunks/a', 'static'],
    ['GET', '/_next/image?url=%2Fa.png&w=64', 'static'],
    ['GET', '/_next/data/build/en/index.json', 'page'],
    ['GET', '/favicon.ico', 'static'],
    ['GET', '/logo.PNG', 'static'],
    ['GET', '/fonts/a.WOFF2?v=3', 'static'],
    ['HEAD', '/robots.txt', 'static'],
    ['GET', '/sitemap.xml', 'static'],
    ['GET', '/manifest.webmanifest', 'static'],
    ['GET', '/a.png/', 'page'],
    ['POST', '/upload.txt', 'page'],
    ['GET', '/api/health', 'api'],
    ['POST', '/api/cart/seats?x=1', 'api'],
    ['GET', '/api/media/abc.png', 'api'],
    ['GET', '/api', 'api'],
    ['GET', '/apiary', 'page'],
    ['GET', '//api/x', 'api'],
    ['GET', undefined, 'page'],
  ];
  for (const [method, url, expected] of table) {
    assert.equal(classifyRequest(method, url), expected, `${method} ${url}`);
  }
});

test('in-flight upstream requests never exceed the class limit; queued requests are all served', async () => {
  const r = await rig({
    concurrency: { page: 4, api: 6, static: 8 },
    queueTimeouts: { page: 0, api: 0, static: 0 },
    delayFor: () => 15,
  });
  try {
    const urls = [
      ...Array.from({ length: 60 }, (_, i) => `/de/page-${i}`),
      ...Array.from({ length: 60 }, (_, i) => `/api/x-${i}`),
      ...Array.from({ length: 60 }, (_, i) => `/a-${i}.png`),
    ];
    const answers = await Promise.all(urls.map((path) => request(r.port, { path })));
    assert.ok(answers.every((a) => a.status === 200));
    assert.ok(r.peak.page <= 4, `page peak ${r.peak.page}`);
    assert.ok(r.peak.api <= 6, `api peak ${r.peak.api}`);
    assert.ok(r.peak.static <= 8, `static peak ${r.peak.static}`);
    assert.ok(r.peak.page >= 2 && r.peak.api >= 2, 'slots are actually used');
    const s = r.stats();
    assert.equal(s.page.served, 60);
    assert.equal(s.page.queued, 0);
    assert.equal(s.page.active, 0);
    assert.equal(s.page.inflight, 0);
  } finally {
    await r.close();
  }
});

test('a flood of slow page requests does not starve api requests', async () => {
  const r = await rig({
    concurrency: { page: 4, api: 8, static: 8 },
    queueTimeouts: { page: 0, api: 0, static: 0 },
    delayFor: (url) => (url.startsWith('/api/') ? 5 : 20),
  });
  try {
    const flood = [];
    for (let i = 0; i < 300; i++) {
      flood.push(request(r.port, { path: `/p-${i}` }));
      if (i % 50 === 49) await sleep(4); // arrive in waves: the OS accept queue is not under test
    }
    await sleep(100);
    assert.ok(r.stats().page.queued > 100, 'the page class is backed up');
    const api = await Promise.all(
      Array.from({ length: 20 }, (_, i) => request(r.port, { path: `/api/seat-${i}` })),
    );
    assert.ok(api.every((a) => a.status === 200));
    const worst = Math.max(...api.map((a) => a.ms));
    assert.ok(worst < 400, `api latency ${worst} ms`);
    assert.ok((await Promise.all(flood)).every((a) => a.status === 200));
    assert.ok(r.peak.page <= 4);
  } finally {
    await r.close();
  }
});

test('waiting longer than the queue timeout: 503 BUSY + Retry-After, the slot is free again', async () => {
  const logs = [];
  const r = await rig({
    concurrency: { page: 1, api: 1, static: 1 },
    queueTimeouts: { page: 150, api: 150, static: 150 },
    delayFor: (url) => (url.includes('slow') ? 600 : 5),
    log: (m) => logs.push(m),
  });
  try {
    const slow = request(r.port, { path: '/slow' });
    const slowApi = request(r.port, { path: '/api/slow' });
    await sleep(40);
    const html = await request(r.port, { path: '/waiting', headers: { accept: 'text/html' } });
    assert.equal(html.status, 503);
    assert.equal(html.headers['retry-after'], '5');
    assert.match(html.body, /<html/);
    assert.ok(html.ms < 450, `answered after ${html.ms} ms`);
    const api = await request(r.port, { path: '/api/waiting', headers: { accept: 'text/html' } });
    assert.equal(api.status, 503);
    assert.equal(api.headers['retry-after'], '5');
    assert.equal(JSON.parse(api.body).error.code, 'BUSY');
    assert.ok(!r.seen.includes('/waiting') && !r.seen.includes('/api/waiting'));
    assert.equal(r.stats().page.queued, 0);
    assert.equal(r.stats().page.busy503, 1);
    assert.equal(r.stats().api.busy503, 1);
    assert.deepEqual([r.proxy.stats().busy503.page, r.proxy.stats().busy503.api], [1, 1]);
    assert.equal((await slow).status, 200);
    assert.equal((await slowApi).status, 200);
    assert.equal((await request(r.port, { path: '/after' })).status, 200);
    assert.equal(r.stats().page.active, 0);
    assert.equal(r.stats().page.inflight, 0);
    await sleep(10);
    assert.ok(
      logs.some((l) => /proxy overload: 1 requests answered 503 BUSY.*page 1, api 0/.test(l)),
      logs.join('|'),
    );
  } finally {
    await r.close();
  }
});

test('a client that aborts while queued frees its queue entry', async () => {
  const r = await rig({
    concurrency: { page: 1, api: 1, static: 1 },
    queueTimeouts: { page: 0, api: 0, static: 0 },
    delayFor: (url) => (url === '/slow' ? 300 : 5),
  });
  try {
    const slow = request(r.port, { path: '/slow' });
    await sleep(40);
    const queued = http.get({ host: '127.0.0.1', port: r.port, path: '/queued', agent: false });
    queued.on('error', () => {});
    await sleep(60);
    assert.equal(r.stats().page.queued, 1);
    queued.destroy();
    await sleep(60);
    assert.equal(r.stats().page.queued, 0);
    assert.equal(r.stats().page.inflight, 1);
    assert.equal((await slow).status, 200);
    assert.ok(!r.seen.includes('/queued'), 'the abandoned request never reached the upstream');
    assert.equal(r.stats().page.inflight, 0);
    assert.equal((await request(r.port, { path: '/next' })).status, 200);
  } finally {
    await r.close();
  }
});

test('stress: 3000 concurrent requests, no resets or timeouts, bounded upstream connections', async () => {
  const r = await rig({
    // the production defaults
    queueTimeouts: { page: 0, api: 0, static: 0 },
    delayFor: (url) => (url.startsWith('/api/') ? 2 : 4),
  });
  try {
    const kinds = ['/de/e/', '/api/x/', '/s/a-'];
    // 3000 requests at once. Windows refuses ~800 simultaneous loopback connects whatever the
    // server does (plain Node http server: ECONNREFUSED), so the client side is capped at 200
    // sockets, which is still far more than the 240 upstream slots of one web process.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
    const pending = [];
    for (let i = 0; i < 3000; i++) {
      pending.push(
        request(r.port, {
          path: `${kinds[i % 3]}${i}${i % 3 === 2 ? '.js' : ''}`,
          agent,
        }).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }),
        ),
      );
    }
    const results = await Promise.all(pending);
    agent.destroy();
    const failed = results.filter((x) => x.status === 'rejected');
    assert.equal(failed.length, 0, failed[0]?.reason?.code);
    assert.ok(results.every((x) => x.value.status === 200));
    assert.ok(r.peak.page <= 16, `page peak ${r.peak.page}`);
    assert.ok(r.peak.api <= 96, `api peak ${r.peak.api}`);
    assert.ok(r.peak.static <= 128, `static peak ${r.peak.static}`);
    assert.ok(r.peakConns() <= 16 + 96 + 128, `upstream connections peak ${r.peakConns()}`);
  } finally {
    await r.close();
  }
});

test('env: concurrency and queue timeout variables are validated', () => {
  const base = {
    APP_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    SESSION_SECRET: 'x'.repeat(40),
    DATABASE_URL: 'postgres://u:p@h/db',
  };
  const ok = resolveEnv(base, { hardware: { cpus: 2 }, memoryLimitBytes: 0 });
  assert.deepEqual(ok.settings.webConcurrency, { page: 16, api: 96, static: 128 });
  assert.deepEqual(ok.settings.queueTimeouts, { page: 30_000, api: 10_000, static: 10_000 });
  const custom = resolveEnv(
    {
      ...base,
      TIX_WEB_PAGE_CONCURRENCY: '4',
      TIX_WEB_API_CONCURRENCY: '10',
      TIX_WEB_STATIC_CONCURRENCY: '20',
      TIX_PROXY_QUEUE_TIMEOUT_MS: '0',
    },
    { hardware: { cpus: 2 }, memoryLimitBytes: 0 },
  );
  assert.deepEqual(custom.settings.webConcurrency, { page: 4, api: 10, static: 20 });
  assert.deepEqual(custom.settings.queueTimeouts, { page: 0, api: 0, static: 0 });
  for (const bad of [
    { TIX_WEB_PAGE_CONCURRENCY: '0' },
    { TIX_WEB_API_CONCURRENCY: 'many' },
    { TIX_WEB_STATIC_CONCURRENCY: '1.5' },
    { TIX_PROXY_QUEUE_TIMEOUT_MS: '-1' },
  ]) {
    const r = resolveEnv({ ...base, ...bad }, { hardware: { cpus: 2 }, memoryLimitBytes: 0 });
    assert.ok(
      r.errors.some((e) => e.startsWith(Object.keys(bad)[0])),
      JSON.stringify(bad),
    );
  }
  const big = resolveEnv(
    { ...base, TIX_WEB_API_CONCURRENCY: '600' },
    { hardware: { cpus: 2 }, memoryLimitBytes: 0 },
  );
  assert.ok(big.notes.some((n) => /listen backlog/.test(n)));
});

test('kernel listen counters are parsed from /proc/net/netstat', () => {
  const text =
    'TcpExt: SyncookiesSent ListenOverflows ListenDrops TW\n' +
    'TcpExt: 0 600 601 9\n' +
    'IpExt: InNoRoutes\nIpExt: 0\n';
  assert.deepEqual(parseListenCounters(text), { listenOverflows: 600, listenDrops: 601 });
  assert.equal(parseListenCounters('nothing'), null);
});
