// Retry rules of the proxy: a reset is retried on the SAME process only, never replayed elsewhere;
// a refused connection may move on, but the number of attempts is capped; not-ready processes are
// out of the rotation.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createProxyServer } from '../proxy.mjs';

const listen = (server, port = 0) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));

const agent = new http.Agent({ keepAlive: false });
function request(port, { path = '/', method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** n fake processes; `die[i] = true` makes process i read the request and drop the connection. */
async function rig(n) {
  const hits = Array(n).fill(0);
  const die = Array(n).fill(false);
  const servers = [];
  const ports = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits[i] += 1;
        if (die[i]) return req.socket.destroy();
        res.writeHead(200);
        res.end(`web${i}`);
      });
    });
    servers.push(s);
    ports.push(await listen(s));
  }
  const proxy = createProxyServer({
    trustedProxies: '',
    upstreamHost: '127.0.0.1',
    webPorts: ports,
    realtimePort: 1,
    getMode: () => null,
    upstreamTimeoutMs: 2_000,
    downBackoffMs: 200,
  });
  const port = await listen(proxy.server);
  return {
    port,
    hits,
    die,
    proxy,
    async kill(i) {
      servers[i].closeAllConnections();
      await new Promise((r) => servers[i].close(r));
    },
    async close() {
      proxy.server.closeAllConnections();
      proxy.destroyAgents();
      proxy.server.close();
      for (const s of servers) {
        s.closeAllConnections();
        s.close();
      }
    },
  };
}

/** one request per process, so every proxy->process socket is pooled (reused next time) */
async function warm(r, n) {
  for (let i = 0; i < n; i++) assert.equal((await request(r.port)).status, 200);
}

test('a reset after the request was read is retried on the same process, never on another', async () => {
  const r = await rig(2);
  try {
    await warm(r, 2);
    r.die.fill(true);
    const before = [...r.hits];
    const res = await request(r.port);
    assert.equal(res.status, 502);
    assert.equal(r.hits[0] - before[0] + (r.hits[1] - before[1]) >= 1, true);
    // the other process never saw this request
    const touched = r.hits.map((h, i) => h - before[i]);
    assert.equal(touched.filter((h) => h > 0).length, 1, `hits ${touched}`);
    assert.ok(Math.max(...touched) <= 2);
  } finally {
    await r.close();
  }
});

test('a POST is never replayed, not even after a reset on a pooled socket', async () => {
  const r = await rig(2);
  try {
    await warm(r, 2);
    r.die.fill(true);
    const before = [...r.hits];
    const res = await request(r.port, { method: 'POST', body: 'abc' });
    assert.equal(res.status, 502);
    assert.equal(r.hits.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0), 1);
  } finally {
    await r.close();
  }
});

test('refused children plus a resetting one: bounded attempts, then a plain 502', async () => {
  const r = await rig(3);
  try {
    await warm(r, 3);
    await r.kill(0);
    await r.kill(1);
    r.die[2] = true;
    const before = r.hits[2];
    const res = await request(r.port);
    assert.equal(res.status, 502);
    assert.ok(r.hits[2] - before <= 2, `process 2 saw ${r.hits[2] - before} attempts`);
  } finally {
    await r.close();
  }
});

test('processes that are not ready get no traffic (GET and POST) until they are', async () => {
  const r = await rig(3);
  try {
    r.proxy.pool.setReady(1, false);
    for (let i = 0; i < 9; i++) assert.equal((await request(r.port)).status, 200);
    for (let i = 0; i < 3; i++) {
      assert.equal((await request(r.port, { method: 'POST', body: 'x' })).status, 200);
    }
    assert.equal(r.hits[1], 0);
    r.proxy.pool.setReady(1, true);
    for (let i = 0; i < 9; i++) await request(r.port);
    assert.ok(r.hits[1] > 0);
  } finally {
    await r.close();
  }
});

test('when no process is ready the proxy still tries (marks may be stale)', async () => {
  const r = await rig(2);
  try {
    r.proxy.pool.setReady(0, false);
    r.proxy.pool.setReady(1, false);
    assert.equal((await request(r.port)).status, 200);
  } finally {
    await r.close();
  }
});
