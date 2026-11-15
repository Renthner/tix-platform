import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import {
  buildUpstreamHeaders,
  createProxyServer,
  isRealtimePath,
  normalizeIp,
  parseTrustedProxies,
  resolveClientIp,
} from '../proxy.mjs';

const none = parseTrustedProxies('').list;
const priv = parseTrustedProxies('private_ranges').list;

test('normalizeIp', () => {
  assert.equal(normalizeIp('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('evil, 1.2.3.4'), null);
  assert.equal(normalizeIp('999.1.1.1'), null);
  assert.equal(normalizeIp(undefined), null);
});

test('parseTrustedProxies: CIDRs, singles, keywords, garbage', () => {
  const p = parseTrustedProxies('10.0.0.0/8 192.0.2.7, 2001:db8::/32 nonsense 1.2.3.4/40');
  assert.deepEqual(p.invalid, ['nonsense', '1.2.3.4/40']);
  assert.equal(p.list.check('10.9.9.9'), true);
  assert.equal(p.list.check('192.0.2.7'), true);
  assert.equal(p.list.check('192.0.2.8'), false);
  assert.equal(p.list.check('2001:db8::5', 'ipv6'), true);
  const pr = parseTrustedProxies('private_ranges').list;
  assert.equal(pr.check('172.20.1.1'), true);
  assert.equal(pr.check('172.32.1.1'), false);
  assert.equal(pr.check('fd12::1', 'ipv6'), true);
  assert.equal(parseTrustedProxies('').empty, true);
});

test('empty TRUSTED_PROXIES: header ignored, peer used', () => {
  assert.equal(resolveClientIp('203.0.113.9', '1.1.1.1, 2.2.2.2', none), '203.0.113.9');
  assert.equal(resolveClientIp('::ffff:203.0.113.9', '1.1.1.1', none), '203.0.113.9');
  // even a private peer is not trusted without configuration
  assert.equal(resolveClientIp('10.0.0.5', '1.1.1.1', none), '10.0.0.5');
});

test('untrusted peer cannot spoof through a configured list', () => {
  assert.equal(resolveClientIp('203.0.113.9', '10.0.0.1', priv), '203.0.113.9');
});

test('trusted peer: right-to-left walk, forged left entries are ignored', () => {
  assert.equal(
    resolveClientIp('10.0.0.1', '6.6.6.6, 198.51.100.4, 10.0.0.2', priv),
    '198.51.100.4',
  );
  assert.equal(resolveClientIp('10.0.0.1', '198.51.100.4', priv), '198.51.100.4');
  assert.equal(resolveClientIp('10.0.0.1', '198.51.100.4, 10.1.1.1', priv), '198.51.100.4');
});

test('trusted peer: no / empty / garbage header', () => {
  assert.equal(resolveClientIp('10.0.0.1', undefined, priv), '10.0.0.1');
  assert.equal(resolveClientIp('10.0.0.1', '', priv), '10.0.0.1');
  assert.equal(resolveClientIp('10.0.0.1', 'unknown', priv), '10.0.0.1');
  assert.equal(resolveClientIp('10.0.0.1', '198.51.100.4, <script>', priv), '10.0.0.1');
  assert.equal(resolveClientIp('10.0.0.1', ['198.51.100.4', '10.0.0.2'], priv), '198.51.100.4');
});

test('all hops trusted: falls back to the peer', () => {
  assert.equal(resolveClientIp('10.0.0.1', '10.0.0.7, 10.0.0.2', priv), '10.0.0.1');
});

test('IPv6 client through a trusted proxy', () => {
  const t = parseTrustedProxies('192.0.2.0/24').list;
  assert.equal(resolveClientIp('192.0.2.1', '2001:db8::77', t), '2001:db8::77');
});

const spoof = {
  host: 'shop.example',
  'x-forwarded-for': '1.2.3.4, 5.6.7.8',
  'x-forwarded-host': 'evil.example',
  'x-forwarded-proto': 'https',
  'x-forwarded-port': '443',
  'x-real-ip': '9.9.9.9',
  forwarded: 'for=9.9.9.9',
  'x-request-id': 'attacker-supplied-id',
  cookie: 'a=b',
};

test('edge mode: all client-supplied forwarding headers are replaced', () => {
  const { headers, clientIp } = buildUpstreamHeaders(spoof, '203.0.113.9', none, {
    requestId: () => 'gen-uuid-0001',
  });
  assert.equal(clientIp, '203.0.113.9');
  assert.equal(headers['x-forwarded-for'], '203.0.113.9');
  assert.equal(headers['x-forwarded-host'], 'shop.example');
  assert.equal(headers['x-forwarded-proto'], 'http');
  assert.equal(headers['x-request-id'], 'gen-uuid-0001');
  for (const h of ['x-real-ip', 'forwarded', 'x-forwarded-port']) {
    assert.equal(headers[h], undefined);
  }
  assert.equal(headers.cookie, 'a=b');
  assert.equal(headers.host, 'shop.example');
});

test('trusted upstream: proto/host/request id honoured, XFF is exactly one address', () => {
  const incoming = {
    host: 'internal:8080',
    'x-forwarded-for': '6.6.6.6, 198.51.100.4',
    'x-forwarded-host': 'shop.example',
    'x-forwarded-proto': 'https',
    'x-request-id': 'edge-req-12345',
  };
  const { headers } = buildUpstreamHeaders(incoming, '10.0.0.2', priv);
  assert.equal(headers['x-forwarded-for'], '198.51.100.4');
  assert.equal(headers['x-forwarded-host'], 'shop.example');
  assert.equal(headers['x-forwarded-proto'], 'https');
  assert.equal(headers['x-request-id'], 'edge-req-12345');
});

test('trusted upstream: malformed values fall back to safe ones', () => {
  const { headers } = buildUpstreamHeaders(
    {
      host: 'h',
      'x-forwarded-proto': 'javascript',
      'x-forwarded-host': 'a b<>',
      'x-request-id': 'x y',
    },
    '10.0.0.2',
    priv,
    { requestId: () => 'gen-uuid-0002' },
  );
  assert.equal(headers['x-forwarded-proto'], 'http');
  assert.equal(headers['x-forwarded-host'], 'h');
  assert.equal(headers['x-request-id'], 'gen-uuid-0002');
});

test('isRealtimePath', () => {
  assert.equal(isRealtimePath('/socket.io/?EIO=4'), true);
  assert.equal(isRealtimePath('/socket.io'), true);
  assert.equal(isRealtimePath('/socket.iox'), false);
  assert.equal(isRealtimePath('/api/socket.io/'), false);
});

// ── end-to-end with stub upstreams ───────────────────────────────────────────
function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

async function rig({ trusted = '', mode = null } = {}) {
  const seen = [];
  const web = http.createServer((req, res) => {
    seen.push({ target: 'web', headers: req.headers, url: req.url });
    if (req.url === '/slow') return; // never answers
    if (req.url === '/echo') {
      res.writeHead(200, {
        server: 'Next',
        via: '1.1 x',
        'x-powered-by': 'x',
        'content-type': 'text/plain',
      });
      return req.pipe(res);
    }
    res.writeHead(200, { server: 'Next', 'content-type': 'text/plain' });
    res.end('web');
  });
  const rt = http.createServer((req, res) => {
    seen.push({ target: 'realtime', headers: req.headers, url: req.url });
    res.writeHead(200).end('realtime');
  });
  rt.on('upgrade', (req, socket) => {
    seen.push({ target: 'realtime-upgrade', headers: req.headers, url: req.url });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\n',
    );
    socket.on('data', (d) => socket.write(d)); // echo
    socket.on('end', () => socket.end());
  });
  const [webPort, rtPort] = [await listen(web), await listen(rt)];
  const state = { mode };
  const proxy = createProxyServer({
    trustedProxies: trusted,
    upstreamHost: '127.0.0.1',
    webPort,
    realtimePort: rtPort,
    getMode: () => state.mode,
    upstreamTimeoutMs: 300,
  });
  const port = await listen(proxy.server);
  return {
    seen,
    port,
    state,
    close: async () => {
      web.closeAllConnections();
      rt.closeAllConnections();
      proxy.server.closeAllConnections();
      proxy.destroyAgents();
      for (const s of [web, rt, proxy.server]) s.close();
    },
  };
}

function request(port, { path = '/', headers = {}, method = 'GET', body } = {}) {
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

test('routes to web and realtime, replaces spoofed headers, strips Server/Via', async () => {
  const r = await rig();
  try {
    const web = await request(r.port, {
      headers: {
        'x-forwarded-for': '1.1.1.1',
        'x-request-id': 'forged-0001',
        host: 'shop.example',
      },
    });
    assert.equal(web.body, 'web');
    assert.equal(web.headers.server, undefined);
    const hit = r.seen.at(-1);
    assert.equal(hit.headers['x-forwarded-for'], '127.0.0.1');
    assert.notEqual(hit.headers['x-request-id'], 'forged-0001');
    assert.match(hit.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(hit.headers.host, 'shop.example');
    assert.equal(hit.headers['x-forwarded-host'], 'shop.example');

    const rt = await request(r.port, { path: '/socket.io/?EIO=4&transport=polling' });
    assert.equal(rt.body, 'realtime');
    assert.equal(r.seen.at(-1).target, 'realtime');
    assert.equal(r.seen.at(-1).url, '/socket.io/?EIO=4&transport=polling');
  } finally {
    await r.close();
  }
});

test('request bodies stream through', async () => {
  const r = await rig();
  try {
    const big = 'x'.repeat(3_000_000);
    const res = await request(r.port, {
      path: '/echo',
      method: 'POST',
      body: big,
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(res.body.length, big.length);
    assert.equal(res.headers.via, undefined);
    assert.equal(res.headers['x-powered-by'], undefined);
  } finally {
    await r.close();
  }
});

test('websocket upgrade is tunnelled to realtime only', async () => {
  const r = await rig();
  try {
    const open = (path) =>
      new Promise((resolve) => {
        const s = net.connect(r.port, '127.0.0.1', () => {
          s.write(
            `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-For: 8.8.8.8\r\n\r\n`,
          );
        });
        let data = '';
        let pinged = false;
        s.on('data', (d) => {
          data += d;
          if (data.includes('\r\n\r\n') && !pinged && data.startsWith('HTTP/1.1 101')) {
            pinged = true;
            s.write('PING');
          }
          if (data.endsWith('PING') || /^HTTP\/1\.1 [45]/.test(data)) {
            s.destroy();
            resolve(data);
          }
        });
      });
    const ok = await open('/socket.io/?EIO=4&transport=websocket');
    assert.match(ok, /^HTTP\/1\.1 101/);
    assert.match(ok, /PING$/);
    const up = r.seen.find((s) => s.target === 'realtime-upgrade');
    assert.equal(up.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(up.headers.upgrade, 'websocket');
    const denied = await open('/api/ws');
    assert.match(denied, /^HTTP\/1\.1 404/);
  } finally {
    await r.close();
  }
});

test('updating mode answers 503 (html or json) without touching upstream', async () => {
  const r = await rig({ mode: 'updating' });
  try {
    const html = await request(r.port, { headers: { accept: 'text/html' } });
    assert.equal(html.status, 503);
    assert.equal(html.headers['retry-after'], '5');
    assert.match(html.body, /Updating/);
    const json = await request(r.port, { path: '/api/health' });
    assert.equal(json.status, 503);
    assert.equal(JSON.parse(json.body).error.code, 'UPDATING');
    assert.equal(r.seen.length, 0);
    r.state.mode = null;
    assert.equal((await request(r.port)).status, 200);
  } finally {
    await r.close();
  }
});

test('hanging upstream -> 504; upstream down -> 503 starting page', async () => {
  const r = await rig();
  try {
    const timeout = await request(r.port, { path: '/slow' });
    assert.equal(timeout.status, 504);
  } finally {
    await r.close();
  }
  const down = createProxyServer({
    trustedProxies: '',
    upstreamHost: '127.0.0.1',
    webPort: 1,
    realtimePort: 1,
    getMode: () => null,
  });
  const port = await listen(down.server);
  const res = await request(port, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 503);
  assert.match(res.body, /starting/i);
  down.destroyAgents();
  down.server.close();
});

test('client abort destroys the upstream request', async () => {
  const r = await rig();
  try {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: r.port, path: '/slow' });
      req.on('error', () => {});
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.seen.filter((s) => s.url === '/slow').length, 1);
  } finally {
    await r.close();
  }
});

test('trusted peer end-to-end passes exactly one address', async () => {
  const r = await rig({ trusted: '127.0.0.1' });
  try {
    await request(r.port, {
      headers: {
        'x-forwarded-for': '6.6.6.6, 198.51.100.4',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'shop.example',
      },
    });
    const h = r.seen.at(-1).headers;
    assert.equal(h['x-forwarded-for'], '198.51.100.4');
    assert.equal(h['x-forwarded-proto'], 'https');
    assert.equal(h['x-forwarded-host'], 'shop.example');
  } finally {
    await r.close();
  }
});

test('a reused keep-alive socket that the upstream drops is retried once (GET)', async () => {
  const served = new WeakSet();
  const seen = [];
  const web = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    if (req.url === '/flaky' && served.has(req.socket)) {
      req.socket.destroy(); // like an idle keep-alive timeout firing at the same moment
      return;
    }
    served.add(req.socket);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  const webPort = await listen(web);
  const proxy = createProxyServer({
    trustedProxies: '',
    upstreamHost: '127.0.0.1',
    webPort,
    realtimePort: 1,
    getMode: () => null,
  });
  const port = await listen(proxy.server);
  try {
    assert.equal((await request(port, { path: '/a' })).status, 200);
    const res = await request(port, { path: '/flaky' });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['GET /a', 'GET /flaky', 'GET /flaky']);
    // a POST on a dropped reused socket is NOT replayed (not idempotent) -> 502
    assert.equal((await request(port, { path: '/a' })).status, 200);
    const post = await request(port, { path: '/flaky', method: 'POST', body: 'x' });
    assert.equal(post.status, 502);
  } finally {
    web.closeAllConnections();
    proxy.destroyAgents();
    proxy.server.closeAllConnections();
    web.close();
    proxy.server.close();
  }
});

test('absolute-form request targets are rejected with 400', async () => {
  const r = await rig();
  try {
    const status = await new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1', () => {
        s.write(
          'GET http://evil.example/x HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n',
        );
      });
      let data = '';
      s.on('data', (d) => (data += d));
      s.on('close', () => resolve(data.split(' ')[1]));
    });
    assert.equal(status, '400');
    assert.equal(r.seen.length, 0);
  } finally {
    await r.close();
  }
});
