// Hardening of the built-in proxy: request framing / smuggling, timeouts, limits, Host, trust config.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import {
  buildAllowedHosts,
  buildUpstreamHeaders,
  checkFraming,
  connectionCapKey,
  createProxyServer,
  hostnameOf,
  isHostAllowed,
  isPrivatePeer,
  listenDualStack,
  parseTrustedProxies,
  trustWarnings,
} from '../proxy.mjs';

const none = parseTrustedProxies('').list;

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

function request(port, { path = '/', headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (answer) => Number(answer.split(' ')[1]);

/** Sends `data` on a fresh connection and collects the answer until the close or `wait` ms. */
function raw(port, data, wait = 400) {
  return new Promise((resolve) => {
    let buf = '';
    const s = net.connect(port, '127.0.0.1', () => s.write(data));
    s.on('data', (d) => (buf += d));
    s.on('error', () => {});
    const done = () => {
      s.destroy();
      resolve(buf);
    };
    s.on('close', () => setTimeout(done, 20));
    setTimeout(done, wait);
  });
}

/** Upstream that records every request including its body and answers `url|body`. */
async function echoRig(cfg = {}) {
  const seen = [];
  const up = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = () => res.end(`${req.url}|${body}`);
      if (req.url === '/hang') setTimeout(reply, cfg.hangMs ?? 600);
      else reply();
    });
  });
  const upPort = await listen(up);
  const { hangMs, ...proxyCfg } = cfg;
  void hangMs;
  const proxy = createProxyServer({
    trustedProxies: '',
    upstreamHost: '127.0.0.1',
    webPort: upPort,
    realtimePort: upPort,
    getMode: () => null,
    ...proxyCfg,
  });
  const port = await listen(proxy.server);
  return {
    seen,
    port,
    proxy,
    close() {
      up.closeAllConnections();
      proxy.server.closeAllConnections();
      proxy.destroyAgents();
      up.close();
      proxy.server.close();
    },
  };
}

const SMUGGLED =
  'GET /smuggled HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 6.6.6.6\r\nX-Request-Id: attackerattacker\r\n\r\n';

test('TRUSTED_PROXIES: malformed prefixes are invalid, never silently /0', () => {
  for (const spec of [
    '10.0.0.0/',
    '10.0.0.0/ 8',
    '10.0.0.0/0x18',
    '10.0.0.0/1e1',
    '10.0.0.0/33',
    '10.0.0.0/+8',
    '10.0.0.0/8.5',
  ]) {
    const p = parseTrustedProxies(spec);
    assert.ok(p.invalid.length > 0, spec);
    assert.equal(p.list.check('8.8.8.8'), false, spec);
    assert.equal(p.list.check('10.1.2.3'), false, spec);
  }
  assert.deepEqual(parseTrustedProxies('::/129').invalid, ['::/129']);
  assert.deepEqual(parseTrustedProxies('0.0.0.0/-1').invalid, ['0.0.0.0/-1']);
  assert.deepEqual(parseTrustedProxies('10.0.0.0/8 ::/0 10.0.0.0/08').invalid, []);
});

test('checkFraming: one framing mechanism, ambiguity is an error', () => {
  const f = (...h) => checkFraming(h);
  assert.deepEqual(f('Host', 'a'), { hasBody: false });
  assert.deepEqual(f('Content-Length', '0'), { hasBody: false, contentLength: '0' });
  assert.deepEqual(f('content-length', ' 12 '), { hasBody: true, contentLength: '12' });
  assert.deepEqual(f('Transfer-Encoding', 'Chunked'), { hasBody: true, chunked: true });
  assert.ok(f('Content-Length', '1', 'content-length', '1').error);
  assert.ok(f('Content-Length', '1', 'Content-Length', '2').error);
  assert.ok(f('Content-Length', '1', 'Transfer-Encoding', 'chunked').error);
  assert.ok(f('Content-Length', '-1').error);
  assert.ok(f('Content-Length', '1e3').error);
  assert.ok(f('Content-Length', '0x10').error);
  assert.ok(f('Transfer-Encoding', 'gzip, chunked').error);
  assert.ok(f('Transfer-Encoding', 'chunked', 'Transfer-Encoding', 'chunked').error);
});

test('headers named by Connection / Proxy-Connection are not forwarded, framing is exempt', () => {
  const { headers } = buildUpstreamHeaders(
    {
      host: 'h',
      connection: 'close, X-Secret, Content-Length, Host',
      'proxy-connection': 'keep-alive',
      'x-secret': 'v',
      'x-keep': 'k',
      'content-length': '3',
    },
    '203.0.113.9',
    none,
  );
  assert.equal(headers['x-secret'], undefined);
  assert.equal(headers['proxy-connection'], undefined);
  assert.equal(headers['x-keep'], 'k');
  assert.equal(headers['content-length'], '3');
  assert.equal(headers.host, 'h');
});

test('smuggling: a GET that announces a body is streamed, so pooled sockets stay in sync', async () => {
  const r = await echoRig();
  try {
    const first = raw(
      r.port,
      `GET /first HTTP/1.1\r\nHost: a\r\nContent-Length: ${SMUGGLED.length}\r\n\r\n${SMUGGLED}`,
    );
    await sleep(100);
    const second = raw(r.port, 'POST /second HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\n\r\nabc');
    const [a, b] = await Promise.all([first, second]);
    assert.equal(statusOf(a), 200);
    assert.ok(a.endsWith(`/first|${SMUGGLED}`));
    assert.equal(statusOf(b), 200);
    assert.ok(b.endsWith('/second|abc'));
    assert.deepEqual(
      r.seen.map((s) => s.url),
      ['/first', '/second'],
    );
    assert.equal(r.seen[0].body, SMUGGLED);
  } finally {
    r.close();
  }
});

test('smuggling: a request inside a POST body never becomes a second upstream request', async () => {
  const r = await echoRig();
  try {
    const answer = await raw(
      r.port,
      `POST /second HTTP/1.1\r\nHost: a\r\nContent-Length: ${SMUGGLED.length}\r\n\r\n${SMUGGLED}`,
    );
    assert.equal(statusOf(answer), 200);
    assert.deepEqual(
      r.seen.map((s) => s.url),
      ['/second'],
    );
    assert.equal(r.seen[0].body, SMUGGLED);
    assert.equal(r.seen[0].headers['x-forwarded-for'], '127.0.0.1');
  } finally {
    r.close();
  }
});

test('framing: chunked bodies (also on GET) and an empty Content-Length reach the upstream intact', async () => {
  const r = await echoRig();
  try {
    const chunked = await raw(
      r.port,
      'GET /c HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n',
    );
    assert.equal(statusOf(chunked), 200);
    assert.equal(r.seen[0].body, 'hello world');
    assert.equal(r.seen[0].headers['content-length'], undefined);
    assert.equal(r.seen[0].headers['transfer-encoding'], 'chunked');
    const empty = await raw(r.port, 'POST /e HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n');
    assert.equal(statusOf(empty), 200);
    assert.equal(r.seen[1].body, '');
  } finally {
    r.close();
  }
});

test('framing: CL+TE conflict, duplicate or invalid Content-Length -> 400, upstream untouched', async () => {
  const r = await echoRig();
  try {
    const bad = [
      'POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      'POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\nabcd',
      'POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 4\r\nContent-Length: 5\r\n\r\nabcd',
      'POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1e1\r\n\r\nabcd',
      'POST / HTTP/1.1\r\nHost: a\r\nContent-Length: -4\r\n\r\nabcd',
      'POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n',
    ];
    for (const data of bad) {
      const answer = await raw(r.port, data, 300);
      assert.match(answer, /^HTTP\/1\.1 (400|501)/, JSON.stringify(data));
    }
    assert.equal(r.seen.length, 0);
  } finally {
    r.close();
  }
});

test('websocket upgrade: only GET + Upgrade: websocket without a body', async () => {
  const r = await echoRig();
  try {
    const hs = (method, extra, upgrade = 'websocket') =>
      `${method} /socket.io/?EIO=4 HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: ${upgrade}\r\n${extra}\r\n`;
    assert.equal(statusOf(await raw(r.port, hs('GET', '', 'h2c'), 300)), 400);
    assert.equal(statusOf(await raw(r.port, hs('POST', ''), 300)), 400);
    assert.equal(
      statusOf(await raw(r.port, hs('GET', 'Content-Length: 4\r\n') + 'abcd', 300)),
      400,
    );
    assert.equal(r.seen.length, 0);
  } finally {
    r.close();
  }
});

test('slow request body: stalled uploads are dropped, slow but steady ones are not', async () => {
  const r = await echoRig({ socketTimeoutMs: 300 });
  try {
    const t0 = Date.now();
    const stalled = await new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1', () =>
        s.write('POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 10\r\n\r\nab'),
      );
      s.on('error', () => {});
      s.on('close', () => resolve(Date.now() - t0));
    });
    assert.ok(stalled < 1500, `closed after ${stalled} ms`);
    // 6 pieces, 150 ms apart: 900 ms in total, but never 300 ms without data
    const answer = await new Promise((resolve) => {
      let buf = '';
      const s = net.connect(r.port, '127.0.0.1', async () => {
        s.write('POST /steady HTTP/1.1\r\nHost: a\r\nContent-Length: 6\r\n\r\n');
        for (const c of 'abcdef') {
          s.write(c);
          await sleep(150);
        }
      });
      s.on('data', (d) => (buf += d));
      s.on('error', () => {});
      setTimeout(() => {
        s.destroy();
        resolve(buf);
      }, 1500);
    });
    assert.equal(statusOf(answer), 200);
    assert.ok(answer.endsWith('/steady|abcdef'));
  } finally {
    r.close();
  }
});

test('a fully received request is not cut by the inactivity timeout while the upstream works', async () => {
  const r = await echoRig({ socketTimeoutMs: 150, hangMs: 500 });
  try {
    const res = await request(r.port, { path: '/hang' });
    assert.equal(res.status, 200);
    assert.equal(res.body, '/hang|');
  } finally {
    r.close();
  }
});

function openIdle(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.on('close', () => (s.dead = true));
    s.on('connect', () => setTimeout(() => resolve(s), 50));
  });
}

test('per-address connection cap applies to direct peers, not to trusted proxies', async () => {
  const r = await echoRig({ maxConnsPerIp: 2 });
  try {
    const a = await openIdle(r.port);
    const b = await openIdle(r.port);
    const c = await openIdle(r.port);
    assert.equal(a.dead, undefined);
    assert.equal(b.dead, undefined);
    assert.equal(c.dead, true);
    a.destroy();
    await sleep(50);
    const d = await openIdle(r.port);
    assert.equal(d.dead, undefined);
    for (const s of [b, c, d]) s.destroy();
  } finally {
    r.close();
  }
  const t = await echoRig({ maxConnsPerIp: 1, trustedProxies: '127.0.0.1' });
  try {
    const socks = [await openIdle(t.port), await openIdle(t.port), await openIdle(t.port)];
    assert.deepEqual(
      socks.map((s) => s.dead),
      [undefined, undefined, undefined],
    );
    socks.forEach((s) => s.destroy());
  } finally {
    t.close();
  }
});

test('upstream socket exhaustion: waiting requests get 503 instead of queueing forever', async () => {
  const r = await echoRig({ maxSockets: 1, queueTimeoutMs: 150, hangMs: 700 });
  try {
    const slow = request(r.port, { path: '/hang' });
    await sleep(50);
    const t0 = Date.now();
    const busy = await request(r.port, { path: '/quick' });
    assert.equal(busy.status, 503);
    assert.equal(JSON.parse(busy.body).error.code, 'BUSY');
    assert.ok(Date.now() - t0 < 600);
    assert.equal((await slow).status, 200);
    assert.equal((await request(r.port, { path: '/quick' })).status, 200);
  } finally {
    r.close();
  }
});

test('Host restriction: 421 for foreign hosts, loopback names and trusted peers pass', async () => {
  const allowedHosts = buildAllowedHosts('https://shop.example', 'alt.example:8443');
  const r = await echoRig({ allowedHosts });
  try {
    const get = (host) =>
      raw(r.port, `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`, 300);
    assert.equal(statusOf(await get('shop.example')), 200);
    assert.equal(statusOf(await get('SHOP.example:8080')), 200);
    assert.equal(statusOf(await get('alt.example')), 200);
    assert.equal(statusOf(await get('localhost:8080')), 200);
    assert.equal(statusOf(await get('127.0.0.1:8080')), 200);
    assert.equal(statusOf(await get('[::1]:8080')), 200);
    assert.equal(statusOf(await get('evil.example')), 421);
    assert.equal(statusOf(await get('shop.example.evil.example')), 421);
    const ws = await raw(
      r.port,
      'GET /socket.io/ HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      300,
    );
    assert.equal(statusOf(ws), 421);
    assert.equal(r.seen.length, 6);
    assert.ok(r.seen.every((s) => !/evil/.test(s.headers.host)));
  } finally {
    r.close();
  }
  // a trusted reverse proxy may rewrite Host (nginx default) and is never checked
  const t = await echoRig({ allowedHosts, trustedProxies: '127.0.0.1' });
  try {
    const answer = await raw(
      t.port,
      'GET / HTTP/1.1\r\nHost: tix:8080\r\nConnection: close\r\n\r\n',
      300,
    );
    assert.equal(statusOf(answer), 200);
  } finally {
    t.close();
  }
});

test('buildAllowedHosts / hostnameOf / isHostAllowed', () => {
  assert.equal(buildAllowedHosts('http://localhost:8080'), null);
  assert.equal(buildAllowedHosts('http://127.0.0.1:8080'), null);
  assert.equal(buildAllowedHosts('https://shop.example', '*'), null);
  assert.equal(buildAllowedHosts(''), null);
  const set = buildAllowedHosts(
    'https://Shop.Example:8443/x',
    'a.example, https://b.example:9000 c.example:81',
  );
  assert.deepEqual(
    [...set].sort(),
    ['127.0.0.1', '::1', 'a.example', 'b.example', 'c.example', 'localhost', 'shop.example'].sort(),
  );
  assert.equal(hostnameOf('[2001:db8::1]:8080'), '2001:db8::1');
  assert.equal(hostnameOf('Shop.example.'), 'shop.example');
  assert.equal(isHostAllowed(undefined, set), false);
  assert.equal(isHostAllowed('', set), false);
  assert.equal(isHostAllowed('anything', null), true);
});

test('trustWarnings: https without trusted proxies, private_ranges, trust-everything', () => {
  assert.equal(trustWarnings('http://localhost:8080', '').length, 0);
  assert.equal(trustWarnings('https://shop.example', '172.18.0.5').length, 0);
  assert.match(trustWarnings('https://shop.example', '')[0], /TRUSTED_PROXIES is empty/);
  const priv = trustWarnings('https://shop.example', 'private_ranges');
  assert.equal(priv.length, 1);
  assert.match(priv[0], /exact IP/);
  assert.match(priv[0], /127\.0\.0\.1:8080:8080/);
  assert.match(trustWarnings('http://x.example', '0.0.0.0/0')[0], /every address/);
});

test('listenDualStack binds and accepts IPv4 clients; falls back without IPv6', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const bound = await listenDualStack(server, 0);
  assert.ok(bound === '::' || bound === '0.0.0.0');
  const status = await new Promise((resolve) =>
    http.get({ host: '127.0.0.1', port: server.address().port }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }),
  );
  assert.equal(status, 200);
  await new Promise((r) => server.close(r));

  const hosts = [];
  const fake = new EventEmitter();
  fake.listen = (port, host) => {
    hosts.push(host);
    setImmediate(() =>
      host === '::'
        ? fake.emit('error', Object.assign(new Error('no ipv6'), { code: 'EAFNOSUPPORT' }))
        : fake.emit('listening'),
    );
  };
  assert.equal(await listenDualStack(fake, 8080), '0.0.0.0');
  assert.deepEqual(hosts, ['::', '0.0.0.0']);

  const busy = new EventEmitter();
  busy.listen = () =>
    setImmediate(() => busy.emit('error', Object.assign(new Error('x'), { code: 'EADDRINUSE' })));
  await assert.rejects(listenDualStack(busy, 8080), { code: 'EADDRINUSE' });
});

test('x-middleware-subrequest from a client is never forwarded', () => {
  const { headers } = buildUpstreamHeaders(
    { host: 'a', 'x-middleware-subrequest': 'middleware:middleware:middleware', accept: '*/*' },
    '203.0.113.9',
    none,
  );
  assert.equal(headers['x-middleware-subrequest'], undefined);
  assert.equal(headers.accept, '*/*');
});

test('connectionCapKey: IPv4 as is, IPv6 per /64 (also compressed and mapped forms)', () => {
  assert.equal(connectionCapKey('203.0.113.9'), '203.0.113.9');
  assert.equal(connectionCapKey('::ffff:203.0.113.9'), '203.0.113.9');
  const a = connectionCapKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  assert.equal(a, '2001:db8:1:2::/64');
  assert.equal(connectionCapKey('2001:0db8:0001:0002::1'), a);
  assert.equal(connectionCapKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), a);
  assert.notEqual(connectionCapKey('2001:db8:1:3::1'), a);
  assert.equal(connectionCapKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(connectionCapKey('::1'), '0:0:0:0::/64');
  assert.equal(connectionCapKey('nonsense'), null);
});

test('isPrivatePeer: private/CGNAT/ULA yes, loopback and public no', () => {
  for (const ip of ['10.1.2.3', '172.18.0.4', '192.168.1.1', '100.64.0.1', 'fd12::1', 'fe80::1']) {
    assert.equal(isPrivatePeer(ip), true, ip);
  }
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '203.0.113.9', '2001:db8::1', 'x']) {
    assert.equal(isPrivatePeer(ip), false, ip);
  }
});

/** Feeds the proxy's connection handler a fake socket from `address`. */
function fakeConnection(server, address) {
  const socket = new EventEmitter();
  socket.remoteAddress = address;
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  server.emit('connection', socket);
  return socket;
}

test('connection cap: log line is throttled with a counter and names TRUSTED_PROXIES for private peers', async () => {
  const lines = [];
  let clock = 1_000_000;
  const r = await echoRig({ maxConnsPerIp: 1, log: (m) => lines.push(m), now: () => clock });
  try {
    fakeConnection(r.proxy.server, '10.0.0.5'); // first is fine (+ private-peer warning, below)
    const refused = [1, 2, 3, 4].map(() => fakeConnection(r.proxy.server, '10.0.0.5'));
    assert.ok(refused.every((s) => s.destroyed));
    const capLines = () => lines.filter((l) => l.includes('connection limit'));
    assert.equal(capLines().length, 1, 'one line per window');
    assert.match(capLines()[0], /1 connection\(s\) refused/);
    assert.match(capLines()[0], /TRUSTED_PROXIES/);
    clock += 9_000;
    fakeConnection(r.proxy.server, '10.0.0.5');
    assert.equal(capLines().length, 1, 'still inside the window');
    clock += 2_000;
    fakeConnection(r.proxy.server, '10.0.0.5');
    assert.equal(capLines().length, 2);
    assert.match(capLines()[1], /5 connection\(s\) refused/);

    // A public peer: no TRUSTED_PROXIES hint in the cap line.
    clock += 11_000;
    fakeConnection(r.proxy.server, '203.0.113.9');
    fakeConnection(r.proxy.server, '203.0.113.9');
    assert.doesNotMatch(capLines().at(-1), /TRUSTED_PROXIES/);

    // IPv6 clients of one /64 share the cap.
    fakeConnection(r.proxy.server, '2001:db8:1:2::1');
    const same64 = fakeConnection(r.proxy.server, '2001:db8:1:2:ffff::9');
    assert.equal(same64.destroyed, true);
    const other64 = fakeConnection(r.proxy.server, '2001:db8:1:3::1');
    assert.equal(other64.destroyed, false);
  } finally {
    r.close();
  }
});

test('private peer with empty TRUSTED_PROXIES: warned once, never for loopback or when trusted', async () => {
  const warn = (l) => l.includes('private address') && l.includes('TRUSTED_PROXIES is empty');
  const a = [];
  const r = await echoRig({ log: (m) => a.push(m) });
  try {
    fakeConnection(r.proxy.server, '127.0.0.1');
    fakeConnection(r.proxy.server, '::1');
    assert.equal(a.filter(warn).length, 0);
    fakeConnection(r.proxy.server, '172.19.0.2');
    fakeConnection(r.proxy.server, '172.19.0.3');
    assert.equal(a.filter(warn).length, 1);
  } finally {
    r.close();
  }
  const b = [];
  const t = await echoRig({ log: (m) => b.push(m), trustedProxies: 'private_ranges' });
  try {
    fakeConnection(t.proxy.server, '172.19.0.2');
    assert.equal(b.filter(warn).length, 0);
  } finally {
    t.close();
  }
});

test('invalid Transfer-Encoding with a body gets exactly one 400 answer', async () => {
  const r = await echoRig();
  try {
    const answer = await raw(
      r.port,
      'POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\nGET / HTTP/1.1\r\nHost: a\r\n\r\n',
      400,
    );
    assert.equal((answer.match(/HTTP\/1\.1 \d{3}/g) ?? []).length, 1, answer);
    assert.match(answer, /^HTTP\/1\.1 400/);
    assert.equal(r.seen.length, 0);
  } finally {
    r.close();
  }
});

test('HTTP/1.0 with chunked: the connection is closed after the response', async () => {
  const r = await echoRig();
  try {
    const answer = await raw(
      r.port,
      'POST /x HTTP/1.0\r\nHost: a\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n',
      1_500,
    );
    // Whatever the answer is (served or rejected), the proxy must not keep the connection open.
    assert.match(answer, /^HTTP\/1\.[01] \d{3}/);
    assert.match(answer, /connection: close/i);
  } finally {
    r.close();
  }
});
