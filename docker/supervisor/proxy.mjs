// Built-in reverse proxy of the single `tix` image: /socket.io/* -> realtime, everything else -> web.
//
// It is the edge of the image (TLS is the operator's reverse proxy) and keeps the security
// semantics the former Caddy configuration had:
//  - The app uses the RIGHT-most X-Forwarded-For entry as the client address. This proxy always
//    sends exactly ONE address in that header, so a client can never forge it.
//  - TRUSTED_PROXIES empty: the proxy is the edge; a client-sent X-Forwarded-For / -Proto / -Host /
//    X-Real-IP / Forwarded / X-Request-Id is discarded and the socket peer is used.
//  - TRUSTED_PROXIES set (space/comma separated IPs, CIDRs, `private_ranges`): when the socket peer
//    is one of them, X-Forwarded-For is walked from the right past trusted hops and the first
//    untrusted address is the client (strict mode). A peer that is not trusted is never believed.
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { UpstreamPool } from './pool.mjs';

/** The `private_ranges` keyword (the set Caddy's keyword of the same name covered). */
export const PRIVATE_RANGES = [
  '192.168.0.0/16',
  '172.16.0.0/12',
  '10.0.0.0/8',
  '127.0.0.1/8',
  'fd00::/8',
  '::1',
];

/** Strips brackets, zone id and the IPv4-mapped IPv6 prefix; returns null for non-IPs. */
export function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return isIP(ip) ? ip : null;
}

/**
 * Parses TRUSTED_PROXIES. Returns { list, invalid }: `list` is a BlockList (empty = trust nobody),
 * `invalid` the tokens that are neither an IP, a CIDR nor `private_ranges`.
 */
export function parseTrustedProxies(spec) {
  const list = new BlockList();
  const invalid = [];
  const tokens = String(spec ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  const add = (token) => {
    const slash = token.indexOf('/');
    const addr = normalizeIp(slash >= 0 ? token.slice(0, slash) : token);
    if (!addr) return false;
    const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (slash < 0) {
      list.addAddress(addr, family);
      return true;
    }
    // Digits only: Number() would accept '', ' 8', '0x18', '1e1', '+8' ...
    const rawPrefix = token.slice(slash + 1);
    if (!/^[0-9]{1,3}$/.test(rawPrefix)) return false;
    const prefix = Number(rawPrefix);
    const max = family === 'ipv6' ? 128 : 32;
    if (prefix > max) return false;
    list.addSubnet(addr, prefix, family);
    return true;
  };
  for (const token of tokens) {
    if (token.toLowerCase() === 'private_ranges') PRIVATE_RANGES.forEach(add);
    else if (!add(token)) invalid.push(token);
  }
  return { list, invalid, empty: tokens.length === 0 || tokens.length === invalid.length };
}

export function isTrusted(list, ip) {
  const addr = normalizeIp(ip);
  if (!addr) return false;
  return list.check(addr, isIP(addr) === 6 ? 'ipv6' : 'ipv4');
}

const NOT_PRIVATE_FOR_WARNING = new BlockList();
const PRIVATE_PEERS = new BlockList();
for (const [addr, prefix, family] of [
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
]) {
  PRIVATE_PEERS.addSubnet(addr, prefix, family);
}
NOT_PRIVATE_FOR_WARNING.addSubnet('127.0.0.0', 8, 'ipv4');
NOT_PRIVATE_FOR_WARNING.addAddress('::1', 'ipv6');

/**
 * True for a private/link-local/CGNAT address that is not loopback. Loopback is the container's own
 * health check and local tools, never a reverse proxy.
 */
export function isPrivatePeer(ip) {
  const addr = normalizeIp(ip);
  if (!addr) return false;
  const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
  return !NOT_PRIVATE_FOR_WARNING.check(addr, family) && PRIVATE_PEERS.check(addr, family);
}

/** Expands an IPv6 address to its 8 groups (lower case, no leading zeros); null if not IPv6. */
function ipv6Groups(addr) {
  if (isIP(addr) !== 6) return null;
  let text = addr.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const hi = ((Number(v4[1]) << 8) | Number(v4[2])).toString(16);
    const lo = ((Number(v4[3]) << 8) | Number(v4[4])).toString(16);
    text = `${text.slice(0, v4.index)}${hi}:${lo}`;
  }
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => g.replace(/^0+(?=.)/, ''));
}

/**
 * The key the per-address connection cap counts under: IPv4 as is, IPv6 aggregated by /64 (one
 * customer typically owns a whole /64, so it must not multiply the cap by rotating addresses).
 */
export function connectionCapKey(ip) {
  const addr = normalizeIp(ip);
  if (!addr) return null;
  const groups = ipv6Groups(addr);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : addr;
}

/**
 * The client address for one request.
 * @param {string|undefined} peer  address of the TCP peer
 * @param {string|string[]|undefined} xff  incoming X-Forwarded-For header value(s)
 * @param {BlockList} trusted
 */
export function resolveClientIp(peer, xff, trusted) {
  const peerIp = normalizeIp(peer) ?? '0.0.0.0';
  if (!isTrusted(trusted, peerIp)) return peerIp;
  const raw = Array.isArray(xff) ? xff.join(',') : (xff ?? '');
  const hops = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Walk from the right: every entry was appended by the hop to its right, which we trust only
  // as long as it is itself a trusted proxy.
  let lastTrusted = peerIp;
  for (let i = hops.length - 1; i >= 0; i--) {
    const ip = normalizeIp(hops[i]);
    // A malformed entry (appended by a trusted hop) is never passed on; fall back to that hop.
    if (!ip) return lastTrusted;
    if (!isTrusted(trusted, ip)) return ip;
    lastTrusted = ip;
  }
  // The whole chain is trusted (client inside the trusted network): the peer is the best guess.
  return peerIp;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;
const HOST = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Builds the header set sent upstream. Pure function (tested directly).
 * @returns {{ headers: object, clientIp: string, requestId: string }}
 */
export function buildUpstreamHeaders(incoming, peer, trusted, opts = {}) {
  const idFn = opts.requestId ?? randomUUID;
  const peerTrusted = isTrusted(trusted, peer);
  const clientIp = resolveClientIp(peer, incoming['x-forwarded-for'], trusted);
  const headers = {};
  // Headers named by the Connection header are hop-by-hop for this hop (RFC 9110 7.6.1). Framing and
  // routing headers are exempt: dropping them would desynchronise the connection / break routing.
  const listed = new Set(
    String(
      Array.isArray(incoming.connection)
        ? incoming.connection.join(',')
        : (incoming.connection ?? ''),
    )
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const keep of ['host', 'content-length', 'transfer-encoding']) listed.delete(keep);
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (listed.has(lower) || lower === 'proxy-connection') continue;
    if (lower === 'x-forwarded-for' || lower === 'x-real-ip' || lower === 'forwarded') continue;
    if (lower === 'x-forwarded-proto' || lower === 'x-forwarded-host') continue;
    if (lower === 'x-forwarded-port' || lower === 'x-forwarded-server') continue;
    if (lower === 'x-request-id') continue;
    // Next.js middleware-bypass header (CVE-2025-29927): only the framework itself may set it.
    if (lower === 'x-middleware-subrequest') continue;
    headers[lower] = value;
  }
  // Re-add the hop-by-hop headers an Upgrade request needs (handled by the caller).
  const first = (v) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const host = incoming.host ?? '';
  const inProto = first(incoming['x-forwarded-proto'])?.toLowerCase();
  const inHost = first(incoming['x-forwarded-host']);
  headers['x-forwarded-for'] = clientIp;
  headers['x-forwarded-proto'] =
    peerTrusted && (inProto === 'http' || inProto === 'https') ? inProto : 'http';
  headers['x-forwarded-host'] = peerTrusted && inHost && HOST.test(inHost) ? inHost : host;
  const inId = first(incoming['x-request-id']);
  const requestId = peerTrusted && inId && REQUEST_ID.test(inId) ? inId : idFn();
  headers['x-request-id'] = requestId;
  return { headers, clientIp, requestId };
}

/** Headers of the upstream response that must not reach the client. */
function cleanResponseHeaders(raw) {
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    if (lower === 'server' || lower === 'via' || lower === 'x-powered-by') continue;
    if (HOP_BY_HOP.includes(lower)) continue;
    out[name] = value;
  }
  return out;
}

const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export function statusPage(kind) {
  const pages = {
    updating: {
      status: 503,
      title: 'Updating',
      text: 'The ticket shop is being updated and will be back in a moment. This page reloads itself.',
      code: 'UPDATING',
    },
    starting: {
      status: 503,
      title: 'Starting',
      text: 'The ticket shop is starting up. This page reloads itself.',
      code: 'STARTING',
    },
    shutdown: {
      status: 503,
      title: 'Restarting',
      text: 'The ticket shop is restarting. Please try again in a moment.',
      code: 'SHUTTING_DOWN',
    },
    bad_gateway: {
      status: 502,
      title: 'Temporarily unavailable',
      text: 'The ticket shop did not answer. Please try again in a moment.',
      code: 'BAD_GATEWAY',
    },
    busy: {
      status: 503,
      title: 'Busy',
      text: 'The ticket shop is very busy right now. Please try again in a moment.',
      code: 'BUSY',
    },
    misdirected: {
      status: 421,
      title: 'Unknown address',
      text: 'This address is not served here. Please use the official address of the ticket shop.',
      code: 'MISDIRECTED_REQUEST',
    },
    timeout: {
      status: 504,
      title: 'Timeout',
      text: 'The ticket shop took too long to answer. Please try again.',
      code: 'GATEWAY_TIMEOUT',
    },
  };
  return pages[kind];
}

function sendStatus(req, res, kind, requestId, opts = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const page = statusPage(kind);
  const wantsHtml = !opts.json && (req.headers.accept ?? '').includes('text/html');
  const retry = page.status === 503 ? { 'retry-after': '5' } : {};
  const common = { 'cache-control': 'no-store', 'x-request-id': requestId, ...retry };
  if (wantsHtml) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(page.title)}</title>${page.status === 503 ? '<meta http-equiv="refresh" content="8">' : ''}<style>body{font:16px system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#fafafa;color:#222}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}}</style></head><body><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.text)}</p></main></body></html>`;
    res.writeHead(page.status, { ...common, 'content-type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } else {
    res.writeHead(page.status, { ...common, 'content-type': 'application/json; charset=utf-8' });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : JSON.stringify({ error: { code: page.code, message: page.text } }),
    );
  }
}

/** Raw HTTP response for a failed WebSocket upgrade. */
function rejectUpgrade(socket, status, reason) {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 5\r\n\r\n`,
    );
  }
  socket.destroy();
}

export const REQUEST_CLASSES = ['page', 'api', 'static'];

/**
 * Request class towards a web process; each class has its own concurrency limit per process so that
 * CPU-bound page renders cannot starve API calls (seat locks, cart) or assets.
 *  - api:    /api/...
 *  - static: /_next/static, /_next/image, and GET/HEAD of a path whose last segment has a file
 *            extension (images, fonts, css, js, ico, webmanifest, txt, xml)
 *  - page:   everything else (HTML renders, server actions, RSC fetches, /_next/data)
 */
export function classifyRequest(method, url) {
  const path = String(url ?? '')
    .split(/[?#]/, 1)[0]
    .replace(/^\/{2,}/, '/');
  if (path === '/api' || path.startsWith('/api/')) return 'api';
  if (path.startsWith('/_next/data/')) return 'page';
  if (path.startsWith('/_next/static/') || path.startsWith('/_next/image')) return 'static';
  if ((method === 'GET' || method === 'HEAD') && /\.[A-Za-z0-9]{1,12}$/.test(path.split('/').pop()))
    return 'static';
  return 'page';
}

/**
 * TcpExt ListenOverflows / ListenDrops of this network namespace (the container's), or null when
 * /proc/net/netstat is not readable (not Linux).
 */
export function parseListenCounters(text) {
  const lines = String(text).split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith('TcpExt:') || !lines[i + 1].startsWith('TcpExt:')) continue;
    const names = lines[i].trim().split(/\s+/).slice(1);
    const values = lines[i + 1].trim().split(/\s+/).slice(1);
    const at = (n) => Number(values[names.indexOf(n)]);
    const overflows = at('ListenOverflows');
    const drops = at('ListenDrops');
    if (Number.isFinite(overflows) && Number.isFinite(drops))
      return { listenOverflows: overflows, listenDrops: drops };
  }
  return null;
}

export function readListenCounters(read = (p) => readFileSync(p, 'utf8')) {
  try {
    return parseListenCounters(read('/proc/net/netstat'));
  } catch {
    return null;
  }
}

/** Logs a warning whenever the kernel's listen queue counters grew; returns a stop function. */
export function watchListenCounters(log, { intervalMs = 10_000, read = readListenCounters } = {}) {
  let last = read();
  const timer = setInterval(() => {
    const cur = read();
    if (
      cur &&
      last &&
      (cur.listenOverflows > last.listenOverflows || cur.listenDrops > last.listenDrops)
    ) {
      log(
        `kernel dropped connection attempts: listen queue overflowed (ListenOverflows +${cur.listenOverflows - last.listenOverflows}, ListenDrops +${cur.listenDrops - last.listenDrops} in the last ${Math.round(intervalMs / 1000)} s). A web process cannot accept connections fast enough; lower TIX_WEB_*_CONCURRENCY or add web processes.`,
      );
    }
    last = cur ?? last;
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function isRealtimePath(url) {
  const path = (url ?? '').split('?')[0];
  return path === '/socket.io' || path.startsWith('/socket.io/');
}

/**
 * Request framing per RFC 9112 6.3, from the RAW header list (the parsed `req.headers` joins
 * duplicates). Exactly one framing mechanism is accepted; anything ambiguous is a 400, because a
 * body the proxy and the upstream disagree about is request smuggling.
 * @returns {{ error: string } | { hasBody: boolean, contentLength?: string, chunked?: boolean }}
 */
export function checkFraming(rawHeaders) {
  const cl = [];
  const te = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (name === 'content-length') cl.push(rawHeaders[i + 1].trim());
    else if (name === 'transfer-encoding') te.push(rawHeaders[i + 1].trim().toLowerCase());
  }
  if (cl.length > 1) return { error: 'duplicate Content-Length' };
  if (te.length > 1) return { error: 'duplicate Transfer-Encoding' };
  if (cl.length && te.length) return { error: 'Content-Length together with Transfer-Encoding' };
  if (cl.length) {
    if (!/^\d{1,15}$/.test(cl[0])) return { error: 'invalid Content-Length' };
    const n = Number(cl[0]);
    return { hasBody: n > 0, contentLength: String(n) };
  }
  if (te.length) {
    if (te[0] !== 'chunked') return { error: 'unsupported Transfer-Encoding' };
    return { hasBody: true, chunked: true };
  }
  return { hasBody: false };
}

/** Lower-case host name of a Host header / URL / bare host (port, brackets and trailing dot removed). */
export function hostnameOf(value) {
  let v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
    try {
      v = new URL(v).host;
    } catch {
      return '';
    }
  }
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end > 0 ? v.slice(1, end) : '';
  }
  if ((v.match(/:/g) ?? []).length === 1) v = v.slice(0, v.indexOf(':'));
  return v.replace(/\.$/, '');
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * The Host names the proxy answers for, or null for "any host".
 *
 * Restricted to APP_URL's host, loopback names (the container health check and local admin use
 * them) and TIX_ALLOWED_HOSTS (comma/space list). No restriction (null) when
 *  - APP_URL points at localhost / a loopback address (development, quick try-out: the shop is then
 *    typically opened through a LAN name or IP we cannot know), or
 *  - TIX_ALLOWED_HOSTS contains `*`.
 * Requests from a trusted proxy (TRUSTED_PROXIES) are never checked: a reverse proxy may rewrite
 * Host to its upstream name (nginx default), and it is trusted for everything else anyway.
 */
export function buildAllowedHosts(appUrl, extra = '') {
  const more = String(extra ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (more.includes('*')) return null;
  const appHost = hostnameOf(appUrl);
  if (!appHost || LOOPBACK_HOSTS.includes(appHost)) return null;
  return new Set([appHost, ...LOOPBACK_HOSTS, ...more.map(hostnameOf).filter(Boolean)]);
}

export function isHostAllowed(hostHeader, allowed) {
  if (!allowed) return true;
  const name = hostnameOf(hostHeader);
  return name !== '' && allowed.has(name);
}

/** Human readable startup warnings about the trust configuration (empty = fine). */
export function trustWarnings(appUrl, trustedProxiesSpec) {
  const warnings = [];
  const tokens = String(trustedProxiesSpec ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  let https = false;
  try {
    https = new URL(appUrl).protocol === 'https:';
  } catch {
    // reported elsewhere
  }
  if (https && tokens.length === 0) {
    warnings.push(
      'APP_URL is https but TRUSTED_PROXIES is empty: the built-in proxy is then the edge, so it ' +
        'reports http and the socket address of your TLS proxy as the client (secure-cookie, ' +
        'rate-limit and audit-log problems). Set TRUSTED_PROXIES to the exact IP/CIDR of your ' +
        'reverse proxy.',
    );
  }
  if (tokens.some((t) => t.toLowerCase() === 'private_ranges')) {
    warnings.push(
      'TRUSTED_PROXIES contains private_ranges: with a published port, Docker (userland proxy / ' +
        'NAT) can make internet clients arrive from a private address and be believed. Prefer the ' +
        'exact IP or CIDR of your reverse proxy and publish port 8080 only on the interface the ' +
        'proxy uses (e.g. 127.0.0.1:8080:8080 or a private network).',
    );
  }
  if (tokens.some((t) => t === '0.0.0.0/0' || t === '::/0')) {
    warnings.push(
      'TRUSTED_PROXIES trusts every address: clients can forge their IP address. Use the exact IP/CIDR of your reverse proxy.',
    );
  }
  return warnings;
}

/**
 * Listens on `::` (dual-stack: IPv4 clients arrive as ::ffff:a.b.c.d) and falls back to 0.0.0.0 when
 * the host has no IPv6. Resolves with the address that was bound.
 */
export function listenDualStack(server, port) {
  return new Promise((resolve, reject) => {
    const attempt = (host, canFallBack) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        if (canFallBack && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(error.code)) {
          return attempt('0.0.0.0', false);
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(host);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    attempt('::', true);
  });
}

/**
 * @param {object} cfg
 * @param {string} cfg.trustedProxies  TRUSTED_PROXIES value
 * @param {number} [cfg.webPort]  single web upstream (shorthand for `webPorts: [webPort]`)
 * @param {number[]} [cfg.webPorts]  the web processes (pool; least requests in flight, round-robin ties)
 * @param {number} cfg.realtimePort
 * @param {() => string|null} cfg.getMode  null = proxy normally; otherwise 'updating'|'starting'|'shutdown'
 * @param {(req, res) => boolean} [cfg.handleLocal]  return true when the request was answered locally
 * @param {number} [cfg.upstreamTimeoutMs]  idle time before the first response byte (default 15 min, 0 = none)
 * @param {number} [cfg.socketTimeoutMs]  inactivity limit of a client socket while the request is
 *   still being received (or the response is not being read); default 120 s, 0 = none. Resets on
 *   every byte, so large uploads on a slow link still work; a stalled one is dropped.
 * @param {number} [cfg.requestTimeoutMs]  max time to receive one whole request (default 1 h, 0 = none)
 * @param {number} [cfg.maxConnsPerIp]  concurrent connections per untrusted peer (default 200, 0 = none)
 * @param {{page?: number, api?: number, static?: number}} [cfg.concurrency]  in-flight upstream
 *   requests per web process and request class (defaults 16 / 96 / 128); excess requests wait in a
 *   queue (a process renders pages CPU-bound and has a small accept queue: never flood it)
 * @param {number} [cfg.maxSockets]  shorthand: the same limit for every class
 * @param {boolean} [cfg.debugUpstream]  answer with `x-tix-upstream: <index>` (tests, TIX_PROXY_DEBUG_UPSTREAM=1)
 * @param {number} [cfg.downBackoffMs]  how long a refused web process is skipped (default 1 s, grows to 5 s)
 * @param {{page?: number, api?: number, static?: number}} [cfg.queueTimeouts]  how long a request
 *   may wait for a free slot before it is answered with 503 BUSY (defaults 30 s page, 10 s api and
 *   static; 0 = wait forever)
 * @param {number} [cfg.queueTimeoutMs]  shorthand: the same wait limit for every class
 * @param {Set<string>|null} [cfg.allowedHosts]  see buildAllowedHosts; null = any Host
 * @param {string} [cfg.upstreamHost]  override the upstream host for both targets (tests)
 * @param {(msg: string) => void} [cfg.log]
 */
export function createProxyServer(cfg) {
  const parsedTrust = parseTrustedProxies(cfg.trustedProxies);
  const trusted = parsedTrust.list;
  const now = cfg.now ?? Date.now;
  // Next's standalone server must be started with HOSTNAME=localhost (127.0.0.1 or 0.0.0.0 change how
  // it builds its internal URLs: 127.0.0.1 causes a redirect loop on `/`), so the web upstream is
  // addressed by name too. Realtime listens on all interfaces.
  const hostFor = (target) => cfg.upstreamHost ?? (target === 'web' ? 'localhost' : '127.0.0.1');
  const timeoutMs = cfg.upstreamTimeoutMs ?? 900_000;
  const socketTimeoutMs = cfg.socketTimeoutMs ?? 120_000;
  const requestTimeoutMs = cfg.requestTimeoutMs ?? 3_600_000;
  const maxConnsPerIp = cfg.maxConnsPerIp ?? 200;
  const DEFAULT_LIMITS = { page: 16, api: 96, static: 128 };
  const DEFAULT_QUEUE_MS = { page: 30_000, api: 10_000, static: 10_000 };
  const limits = {};
  const queueMs = {};
  for (const cls of REQUEST_CLASSES) {
    limits[cls] = cfg.concurrency?.[cls] ?? cfg.maxSockets ?? DEFAULT_LIMITS[cls];
    queueMs[cls] = cfg.queueTimeouts?.[cls] ?? cfg.queueTimeoutMs ?? DEFAULT_QUEUE_MS[cls];
  }
  const allowedHosts = cfg.allowedHosts ?? null;
  const log = cfg.log ?? (() => {});
  const pool = new UpstreamPool(cfg.webPorts?.length ? cfg.webPorts : [cfg.webPort], {
    now,
    backoffMs: cfg.downBackoffMs,
    limits,
  });
  const agentFor = {
    // one keep-alive agent per web process and request class; maxSockets = the class limit
    web: pool.ports.map(() =>
      Object.fromEntries(
        REQUEST_CLASSES.map((cls) => [
          cls,
          new http.Agent({ keepAlive: true, maxSockets: limits[cls] }),
        ]),
      ),
    ),
  };
  // Overload log: one throttled line per interval when requests were answered 503 BUSY.
  const BUSY_LOG_INTERVAL_MS = 10_000;
  const busyTotals = { page: 0, api: 0, static: 0 };
  const busyPending = { page: 0, api: 0, static: 0 };
  let busyLastLog = -Infinity;
  let busyTimer = null;
  const queuedNow = () =>
    pool
      .stats()
      .reduce((sum, c) => sum + Object.values(c.classes).reduce((s, k) => s + k.queued, 0), 0);
  const flushBusyLog = () => {
    busyTimer = null;
    const { page, api, static: assets } = busyPending;
    const total = page + api + assets;
    if (total === 0) return;
    busyPending.page = busyPending.api = busyPending.static = 0;
    busyLastLog = now();
    log(
      `proxy overload: ${total} requests answered 503 BUSY in the last ${BUSY_LOG_INTERVAL_MS / 1000} s ` +
        `(page ${page}, api ${api}${assets ? `, static ${assets}` : ''}), queued now ${queuedNow()}`,
    );
  };
  const recordBusy = (cls) => {
    busyTotals[cls] += 1;
    busyPending[cls] += 1;
    if (busyTimer) return;
    const wait = BUSY_LOG_INTERVAL_MS - (now() - busyLastLog);
    if (wait <= 0) flushBusyLog();
    else {
      busyTimer = setTimeout(flushBusyLog, wait);
      busyTimer.unref();
    }
  };
  // Realtime: long-polling requests are long-lived and the gateway closes idle sockets after 5 s
  // (Node default): no pooling, loopback connections are cheap.
  agentFor.realtime = new http.Agent({ keepAlive: false, maxSockets: 8192 });
  const sockets = new Set();
  /** sockets that already got an error answer (a clientError afterwards must not add another). */
  const answered = new WeakSet();
  /** socket -> the request/response currently being served on it (for the inactivity timeout) */
  const active = new WeakMap();

  // headersTimeout protects against slowloris on the header block; the body is bounded by the
  // inactivity timeout below (large uploads: backups, APKs, bank files) and requestTimeoutMs.
  const server = http.createServer(
    {
      keepAliveTimeout: 65_000,
      headersTimeout: requestTimeoutMs > 0 ? Math.min(30_000, requestTimeoutMs) : 30_000,
      requestTimeout: requestTimeoutMs,
    },
    (req, res) => {
      const peer = req.socket.remoteAddress;
      // Pipelined bytes behind a rejected request are never served.
      if (answered.has(req.socket)) {
        req.socket.destroy();
        return;
      }
      const framing = checkFraming(req.rawHeaders);
      if (framing.error) {
        log(`proxy rejected request: ${framing.error}`);
        // One answer only: bytes of the unparsed body must not trigger a second 400 (clientError).
        answered.add(req.socket);
        res.writeHead(400, { 'content-length': '0', connection: 'close' }).end();
        return;
      }
      // HTTP/1.0 has no chunked coding: such a request is malformed or an attempt to confuse
      // framing. It is served, but this connection is closed afterwards.
      if (req.httpVersion === '1.0' && framing.chunked) res.shouldKeepAlive = false;
      active.set(req.socket, { req, res });
      res.on('close', () => {
        if (active.get(req.socket)?.res === res) active.delete(req.socket);
      });
      const { headers, requestId } = buildUpstreamHeaders(req.headers, peer, trusted);
      if (!isTrusted(trusted, peer) && !isHostAllowed(req.headers.host, allowedHosts)) {
        return sendStatus(req, res, 'misdirected', requestId);
      }
      const mode = cfg.getMode();
      if (cfg.handleLocal?.(req, res, requestId)) return;
      // Only origin-form targets ("/path"): an absolute-form target would not be routed sanely.
      if (!req.url?.startsWith('/')) {
        answered.add(req.socket);
        res.writeHead(400, { 'content-length': '0', connection: 'close' }).end();
        return;
      }
      if (mode) return sendStatus(req, res, mode, requestId);

      const target = isRealtimePath(req.url) ? 'realtime' : 'web';
      for (const h of HOP_BY_HOP) delete headers[h];
      delete headers['content-length'];
      delete headers.expect; // answered by this proxy (100 Continue), not the upstream's business
      // Exactly one framing mechanism goes upstream, derived from the HEADERS (not the method): a
      // GET that announces a body is streamed like any other request.
      if (framing.contentLength !== undefined) headers['content-length'] = framing.contentLength;
      else if (framing.chunked) headers['transfer-encoding'] = 'chunked';
      // A body-less request on a dropped pooled socket can safely be sent once more.
      const retryable =
        !framing.hasBody &&
        (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS');
      const cls = target === 'web' ? classifyRequest(req.method, req.url) : null;
      let current = null;
      let clientGone = false;
      /** gives up the slot (or queue entry) of the attempt in progress */
      let cancelPending = null;
      res.on('close', () => {
        if (!res.writableFinished) {
          clientGone = true;
          cancelPending?.(); // still waiting for a slot: leave the queue
          current?.destroy(); // stop the upstream work, free the socket
        }
      });

      /** web processes this request was already sent to (each at most once, except the reset retry) */
      const tried = new Set();
      /** the single "stale keep-alive socket" retry (same process); once used, never fail over */
      let resetRetried = false;
      // framing is checked and the headers are built above, BEFORE a process is chosen
      const attempt = (forcedIndex) => {
        let index = 0;
        if (target === 'web') {
          index = forcedIndex ?? pool.pick(tried, cls);
          if (index === null) {
            // nothing left to try: "Starting" only when no process is up
            sendStatus(req, res, pool.allDown() ? 'starting' : 'bad_gateway', requestId);
            return;
          }
          tried.add(index);
          pool.begin(index, cls);
        }
        let released = false;
        let entry = null;
        const release = () => {
          if (released) return;
          released = true;
          if (cancelPending === release) cancelPending = null;
          if (target === 'web') {
            entry.release();
            pool.end(index, cls);
          }
        };
        if (target === 'web') {
          entry = pool.acquire(index, cls);
          cancelPending = release;
          if (!entry.granted) {
            // Wait for a slot of this class on this process (bounded by the queue timeout).
            let timer = null;
            if (queueMs[cls] > 0) {
              timer = setTimeout(() => {
                release();
                pool.noteBusy(index, cls);
                recordBusy(cls);
                sendStatus(req, res, 'busy', requestId, { json: cls === 'api' });
              }, queueMs[cls]);
            }
            entry.onGrant = () => {
              clearTimeout(timer);
              if (clientGone) return release();
              dispatch();
            };
            return;
          }
        }
        dispatch();

        function dispatch() {
          let upstream;
          try {
            upstream = http.request(
              {
                host: hostFor(target),
                port: target === 'realtime' ? cfg.realtimePort : pool.children[index].port,
                method: req.method,
                path: req.url,
                headers,
                agent: target === 'realtime' ? agentFor.realtime : agentFor.web[index][cls],
                setHost: false,
              },
              (up) => {
                up.setTimeout(0);
                if (target === 'web') pool.markUp(index);
                const outHeaders = cleanResponseHeaders(up.headers);
                if (cfg.debugUpstream && target === 'web')
                  outHeaders['x-tix-upstream'] = String(index);
                outHeaders['x-request-id'] ??= requestId;
                res.writeHead(up.statusCode ?? 502, up.statusMessage, outHeaders);
                up.pipe(res); // honours backpressure
                up.on('error', () => res.destroy());
              },
            );
          } catch (e) {
            // e.g. an invalid header value: the slot must not leak
            release();
            log(`proxy ${target} request failed ${e.code ?? e.message} id=${requestId}`);
            sendStatus(req, res, 'bad_gateway', requestId);
            return;
          }
          current = upstream;
          upstream.once('close', release);
          if (timeoutMs > 0) {
            upstream.setTimeout(timeoutMs, () =>
              upstream.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
            );
          }
          upstream.on('error', (err) => {
            // Nothing listens on that web process (starting / restarting / dead): skip it for a moment.
            if (target === 'web' && err.code === 'ECONNREFUSED') pool.markDown(index);
            if (clientGone || res.writableEnded || res.destroyed) return;
            // A pooled keep-alive socket that the upstream closed in the meantime: a body-less request
            // is sent once more to the SAME process on a fresh socket. An ECONNRESET can also mean
            // that the process read the request and died, so it never fails over to another process.
            if (!resetRetried && retryable && upstream.reusedSocket && err.code === 'ECONNRESET') {
              resetRetried = true;
              release();
              return attempt(target === 'web' ? index : undefined);
            }
            // Refused: nothing was received. A body-less request moves on to a process it has not
            // been sent to yet (never after a reset retry; a request with a body is never repeated).
            if (target === 'web' && err.code === 'ECONNREFUSED' && retryable && !resetRetried) {
              const next = pool.pick(tried, cls);
              if (next !== null) {
                release();
                return attempt(next);
              }
            }
            log(
              `proxy ${target} error ${err.code ?? err.message} ${req.method} ${req.url.split('?')[0]} id=${requestId}`,
            );
            // "Starting" only when no web process is up (all refuse); a refusal by one of several is
            // a plain bad gateway.
            const kind =
              err.code === 'ETIMEDOUT'
                ? 'timeout'
                : err.code === 'ECONNREFUSED' && (target !== 'web' || pool.allDown())
                  ? 'starting'
                  : 'bad_gateway';
            sendStatus(req, res, kind, requestId);
          });
          if (!framing.hasBody) {
            upstream.end();
          } else {
            req.pipe(upstream); // honours backpressure; ends upstream when the body ends
            req.on('error', () => upstream.destroy());
          }
        }
      };
      attempt();
    },
  );

  if (socketTimeoutMs > 0) {
    server.setTimeout(socketTimeoutMs);
    server.on('timeout', (socket) => {
      const a = active.get(socket);
      // The request has been received completely and the client keeps reading: the upstream is
      // working (bounded by upstreamTimeoutMs), nothing to cut. Anything else is stalled or idle.
      if (a && a.req.complete && !a.res.writableNeedDrain) {
        socket.setTimeout(socketTimeoutMs);
        return;
      }
      socket.destroy();
    });
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const peer = req.socket.remoteAddress;
    const framing = checkFraming(req.rawHeaders);
    if (framing.error || framing.hasBody) return rejectUpgrade(socket, 400, 'Bad Request');
    if (!isTrusted(trusted, peer) && !isHostAllowed(req.headers.host, allowedHosts)) {
      return rejectUpgrade(socket, 421, 'Misdirected Request');
    }
    if (cfg.getMode()) return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (!isRealtimePath(req.url)) return rejectUpgrade(socket, 404, 'Not Found');
    // Only WebSocket is tunnelled, and only as a GET (RFC 6455); any other protocol would turn the
    // proxy into an opaque TCP pipe.
    if (req.method !== 'GET' || (req.headers.upgrade ?? '').trim().toLowerCase() !== 'websocket') {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    const { headers } = buildUpstreamHeaders(req.headers, peer, trusted);
    for (const h of HOP_BY_HOP) delete headers[h];
    delete headers['content-length'];
    // Re-add what the upgrade handshake needs.
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const upstream = http.request({
      host: hostFor('realtime'),
      port: cfg.realtimePort,
      method: 'GET',
      path: req.url,
      headers,
      agent: false, // never share a pooled socket with a connection that turns into a tunnel
      setHost: false,
    });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      upSocket.on('error', () => socket.destroy());
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [k, v] of Object.entries(cleanResponseHeadersForUpgrade(upRes.headers))) {
        for (const item of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${item}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.setNoDelay(true);
      socket.setNoDelay(true);
      socket.setTimeout(0); // the tunnel is long-lived; socket.io pings keep it honest
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      socket.on('close', () => upSocket.destroy());
      upSocket.on('close', () => socket.destroy());
      // Half-closed (one side sent FIN, the other never answers): do not keep the pair forever.
      const halfClosed = () => {
        const t = setTimeout(() => {
          socket.destroy();
          upSocket.destroy();
        }, 10_000);
        t.unref();
      };
      socket.on('end', halfClosed);
      upSocket.on('end', halfClosed);
    });
    upstream.on('response', (upRes) => {
      // The upstream refused the upgrade (plain HTTP answer): relay status and drop.
      rejectUpgrade(socket, upRes.statusCode ?? 502, 'Upgrade refused');
      upRes.resume();
    });
    upstream.on('error', () => rejectUpgrade(socket, 502, 'Bad Gateway'));
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });

  const perPeer = new Map();
  // The cap hit is logged at most once per window, with the number of refused connections.
  const CAP_LOG_INTERVAL_MS = 10_000;
  let capRefused = 0;
  let capLastLog = -Infinity;
  let privatePeerWarned = false;
  server.on('connection', (socket) => {
    const peer = normalizeIp(socket.remoteAddress);
    // Nothing is trusted but clients arrive from a private (non-loopback) address: that is almost
    // always the operator's own reverse proxy, whose visitors would all be counted as one client.
    if (!privatePeerWarned && parsedTrust.empty && peer && isPrivatePeer(peer)) {
      privatePeerWarned = true;
      log(
        `proxy: connections arrive from the private address ${peer} but TRUSTED_PROXIES is empty, so ` +
          'the built-in proxy treats it as the client: every visitor behind it shares one address ' +
          '(per-address connection cap, rate limits, audit log) and X-Forwarded-Proto/-For are ignored. ' +
          'If that is your reverse proxy, set TRUSTED_PROXIES to its exact IP/CIDR.',
      );
    }
    // Trusted proxies multiplex many clients over their connections: the cap is for direct peers.
    // IPv6 peers are counted per /64.
    if (maxConnsPerIp > 0 && peer && !isTrusted(trusted, peer)) {
      const key = connectionCapKey(peer);
      const n = perPeer.get(key) ?? 0;
      if (n >= maxConnsPerIp) {
        capRefused += 1;
        const t = now();
        if (t - capLastLog >= CAP_LOG_INTERVAL_MS) {
          capLastLog = t;
          const refused = capRefused;
          capRefused = 0;
          log(
            `proxy: connection limit (${maxConnsPerIp} per client address) reached for ${key}; ` +
              `${refused} connection(s) refused since the last message` +
              (isPrivatePeer(peer)
                ? ` - ${peer} is a private address: if it is your reverse proxy, set TRUSTED_PROXIES to its IP/CIDR (all visitors behind it are counted as one client)`
                : ''),
          );
        }
        socket.destroy();
        return;
      }
      perPeer.set(key, n + 1);
      socket.once('close', () => {
        const left = (perPeer.get(key) ?? 1) - 1;
        if (left <= 0) perPeer.delete(key);
        else perPeer.set(key, left);
      });
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (err, socket) => {
    // A framing/URL rejection already answered this socket: do not send a second 400.
    if (socket.writable && !answered.has(socket)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else socket.destroy();
  });

  return {
    server,
    /** The web upstream pool (the supervisor drives its ready state). */
    pool,
    /** Effective per-process limits and queue timeouts per request class. */
    limits,
    queueTimeouts: queueMs,
    /** Per class and web process: queued now, served, busy503 (cumulative); plus busy totals. */
    stats() {
      return {
        limits,
        queueTimeoutMs: queueMs,
        busy503: { ...busyTotals },
        children: pool.stats(),
      };
    },
    /** Drops pooled upstream connections (they would keep the process alive). */
    destroyAgents() {
      for (const agents of agentFor.web) for (const agent of Object.values(agents)) agent.destroy();
      agentFor.realtime.destroy();
    },
    /** Stops accepting connections, then force-closes what is left after `graceMs`. */
    close(graceMs = 5_000) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          for (const s of sockets) s.destroy();
        }, graceMs);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          this.destroyAgents();
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}

function cleanResponseHeadersForUpgrade(raw) {
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    if (lower === 'server' || lower === 'via' || lower === 'x-powered-by') continue;
    out[name] = value;
  }
  return out;
}
