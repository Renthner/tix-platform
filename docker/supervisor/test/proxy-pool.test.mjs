// The proxy with several web processes: distribution, failover, retry rules.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { createProxyServer } from '../proxy.mjs';

const listen = (server, port = 0) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));

function request(port, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** n fake web processes that answer with their index; `hits` counts per process. */
async function rig(n, extra = {}) {
  const hits = Array(n).fill(0);
  const servers = [];
  const ports = [];
  const handler = (i) => (req, res) => {
    hits[i] += 1;
    if (req.url === '/slow') return; // never answers
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200);
      res.end(`web${i}:${Buffer.concat(chunks).length}`);
    });
  };
  for (let i = 0; i < n; i++) {
    const s = http.createServer(handler(i));
    servers.push(s);
    ports.push(await listen(s));
  }
  const proxy = createProxyServer({
    trustedProxies: '',
    upstreamHost: '127.0.0.1',
    webPorts: ports,
    realtimePort: 1,
    getMode: () => null,
    debugUpstream: true,
    upstreamTimeoutMs: 400,
    downBackoffMs: 200,
    ...extra,
  });
  const port = await listen(proxy.server);
  return {
    port,
    hits,
    proxy,
    /** simulates a dead process: nothing listens on its port any more */
    async kill(i) {
      servers[i].closeAllConnections();
      await new Promise((r) => servers[i].close(r));
    },
    async revive(i) {
      servers[i] = http.createServer(handler(i));
      await listen(servers[i], ports[i]);
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

test('requests are spread over every web process (debug header names the upstream)', async () => {
  const r = await rig(3);
  try {
    const used = new Set();
    for (let i = 0; i < 12; i++) {
      const res = await request(r.port);
      assert.equal(res.status, 200);
      used.add(res.headers['x-tix-upstream']);
    }
    assert.deepEqual([...used].sort(), ['0', '1', '2']);
    assert.deepEqual(r.hits, [4, 4, 4]);
  } finally {
    await r.close();
  }
});

test('the debug header is absent unless enabled', async () => {
  const r = await rig(2, { debugUpstream: false });
  try {
    const res = await request(r.port);
    assert.equal(res.headers['x-tix-upstream'], undefined);
  } finally {
    await r.close();
  }
});

test('a dead web process is skipped: requests keep working', async () => {
  const r = await rig(3);
  try {
    await r.kill(1);
    for (let i = 0; i < 12; i++) {
      const res = await request(r.port);
      assert.equal(res.status, 200, `request ${i}`);
      assert.notEqual(res.headers['x-tix-upstream'], '1');
    }
    // known-down processes are avoided for requests with a body too
    const post = await request(r.port, {
      method: 'POST',
      body: 'abc',
      headers: { 'content-length': '3' },
    });
    assert.equal(post.status, 200);
    assert.match(post.body, /:3$/);
  } finally {
    await r.close();
  }
});

test('GET meeting a freshly dead process is retried elsewhere; a request with a body is not', async () => {
  const r = await rig(2);
  try {
    await r.kill(0);
    // child 0 is next in the rotation and not yet marked down
    const get = await request(r.port);
    assert.equal(get.status, 200);
    assert.equal(get.headers['x-tix-upstream'], '1');
    await sleep(250); // backoff over: child 0 is offered first again
    const before = r.hits[1];
    const post = await request(r.port, {
      method: 'POST',
      body: 'xy',
      headers: { 'content-length': '2' },
    });
    // refused by one of two: a plain bad gateway (the Starting page is for "none is up")
    assert.equal(post.status, 502);
    assert.equal(r.hits[1], before, 'the body request was not repeated on the other process');
  } finally {
    await r.close();
  }
});

test('no web process up: "Starting" page; one comes back: traffic resumes', async () => {
  const r = await rig(2);
  try {
    await r.kill(0);
    await r.kill(1);
    const down = await request(r.port, { headers: { accept: 'text/html' } });
    assert.equal(down.status, 503);
    assert.match(down.body, /starting/i);
    await r.revive(1);
    await sleep(250);
    let ok = 0;
    for (let i = 0; i < 6; i++) if ((await request(r.port)).status === 200) ok += 1;
    assert.equal(ok, 6);
  } finally {
    await r.close();
  }
});

test('framing is checked before a process is chosen (400, no upstream contact)', async () => {
  const r = await rig(2);
  try {
    const res = await new Promise((resolve) => {
      const socket = net.connect(r.port, '127.0.0.1', () => {
        socket.write(
          'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab',
        );
      });
      let data = '';
      socket.on('data', (d) => (data += d));
      socket.on('close', () => resolve(data));
    });
    assert.match(res, /^HTTP\/1\.1 400/);
    assert.deepEqual(r.hits, [0, 0]);
  } finally {
    await r.close();
  }
});

test('a timed-out request does not mark a healthy process down', async () => {
  const r = await rig(2, { upstreamTimeoutMs: 300 });
  try {
    const slow = await request(r.port, { path: '/slow' });
    assert.equal(slow.status, 504);
    const used = new Set();
    for (let i = 0; i < 6; i++) used.add((await request(r.port)).headers['x-tix-upstream']);
    assert.deepEqual([...used].sort(), ['0', '1']);
  } finally {
    await r.close();
  }
});
