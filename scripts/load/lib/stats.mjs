// Pure building blocks of the journey load test (no I/O, unit tested in scripts/load/test):
// mergeable log-bucket latency histograms, ramp schedules, hold-interval exclusivity check,
// target safety guard and a few small parsers.

// ── latency histogram ─────────────────────────────────────────────────────────────
// Fixed log-spaced buckets (ratio 1.05, 0.1 ms .. ~10 min): constant memory per label however many
// requests, exact merge across worker processes, percentile error below 5 %.
const MIN_MS = 0.1;
const RATIO = 1.05;
const LOG_RATIO = Math.log(RATIO);
const BUCKETS = Math.ceil(Math.log(600_000 / MIN_MS) / LOG_RATIO) + 1;

export class Histogram {
  constructor() {
    this.counts = new Map(); // bucket index -> count (sparse, JSON friendly)
    this.n = 0;
    this.max = 0;
    this.sum = 0;
  }
  static bucketOf(ms) {
    if (!(ms > MIN_MS)) return 0;
    return Math.min(BUCKETS - 1, Math.floor(Math.log(ms / MIN_MS) / LOG_RATIO));
  }
  static upperBound(bucket) {
    return MIN_MS * RATIO ** (bucket + 1);
  }
  record(ms) {
    const b = Histogram.bucketOf(ms);
    this.counts.set(b, (this.counts.get(b) ?? 0) + 1);
    this.n++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }
  merge(other) {
    for (const [b, c] of other.counts) this.counts.set(b, (this.counts.get(b) ?? 0) + c);
    this.n += other.n;
    this.sum += other.sum;
    if (other.max > this.max) this.max = other.max;
    return this;
  }
  percentile(p) {
    if (this.n === 0) return null;
    const rank = Math.max(1, Math.ceil((p / 100) * this.n));
    let seen = 0;
    for (const b of [...this.counts.keys()].sort((a, c) => a - c)) {
      seen += this.counts.get(b);
      if (seen >= rank) return Math.min(Histogram.upperBound(b), this.max);
    }
    return this.max;
  }
  toJSON() {
    return { n: this.n, max: this.max, sum: this.sum, counts: [...this.counts] };
  }
  static fromJSON(j) {
    const h = new Histogram();
    h.n = j.n;
    h.max = j.max;
    h.sum = j.sum;
    h.counts = new Map(j.counts);
    return h;
  }
}

const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

/** Per-label request statistics: status / error-code counters + latency histogram. Mergeable. */
export class EndpointStats {
  constructor() {
    this.labels = new Map();
  }
  record(label, status, code, ms, bytes = 0) {
    let m = this.labels.get(label);
    if (!m) {
      m = { n: 0, statuses: {}, codes: {}, hist: new Histogram(), bad: 0, bytes: 0 };
      this.labels.set(label, m);
    }
    m.n++;
    m.bytes += bytes;
    m.statuses[status] = (m.statuses[status] ?? 0) + 1;
    if (code) {
      const k = `${status}:${code}`;
      m.codes[k] = (m.codes[k] ?? 0) + 1;
    }
    if (status === 0 || status >= 500) m.bad++;
    m.hist.record(ms);
  }
  /**
   * Counts a response that arrived with a success status but could not be used (for example a null
   * or non-JSON body): an endpoint failure, not a crash of the virtual user. Adds no request.
   */
  markFailure(label, code) {
    let m = this.labels.get(label);
    if (!m) {
      m = { n: 0, statuses: {}, codes: {}, hist: new Histogram(), bad: 0, bytes: 0 };
      this.labels.set(label, m);
    }
    m.bad++;
    const k = `200:${code}`;
    m.codes[k] = (m.codes[k] ?? 0) + 1;
  }
  merge(other) {
    for (const [label, o] of other.labels) {
      let m = this.labels.get(label);
      if (!m) {
        m = { n: 0, statuses: {}, codes: {}, hist: new Histogram(), bad: 0, bytes: 0 };
        this.labels.set(label, m);
      }
      m.n += o.n;
      m.bad += o.bad;
      m.bytes += o.bytes ?? 0;
      for (const [k, v] of Object.entries(o.statuses)) m.statuses[k] = (m.statuses[k] ?? 0) + v;
      for (const [k, v] of Object.entries(o.codes)) m.codes[k] = (m.codes[k] ?? 0) + v;
      m.hist.merge(o.hist);
    }
    return this;
  }
  toJSON() {
    return [...this.labels].map(([label, m]) => [label, { ...m, hist: m.hist.toJSON() }]);
  }
  static fromJSON(list) {
    const s = new EndpointStats();
    for (const [label, m] of list) s.labels.set(label, { ...m, hist: Histogram.fromJSON(m.hist) });
    return s;
  }
  /** Summary object for the report. `seconds` = wall-clock duration of the measured phase. */
  summary(seconds) {
    const endpoints = {};
    let total = 0;
    let bad = 0;
    let limited = 0;
    let unavailable = 0;
    let bytes = 0;
    let timeouts = 0;
    const timeoutsByEndpoint = {};
    for (const [label, m] of [...this.labels].sort((a, b) => a[0].localeCompare(b[0]))) {
      total += m.n;
      bad += m.bad;
      limited += m.statuses[429] ?? 0;
      unavailable += m.statuses[503] ?? 0;
      bytes += m.bytes ?? 0;
      const timedOut = m.codes['0:TIMEOUT'] ?? 0;
      timeouts += timedOut;
      if (timedOut > 0) timeoutsByEndpoint[label] = timedOut;
      endpoints[label] = {
        requests: m.n,
        p50: round1(m.hist.percentile(50)),
        p95: round1(m.hist.percentile(95)),
        p99: round1(m.hist.percentile(99)),
        max: round1(m.hist.max),
        statuses: m.statuses,
        codes: m.codes,
        failures5xxOrNetwork: m.bad,
        timeouts: timedOut,
        bytesReceived: m.bytes ?? 0,
      };
    }
    return {
      requests: total,
      requestsPerSecond: seconds > 0 ? round1(total / seconds) : null,
      failures5xxOrNetwork: bad,
      failureRate: total ? bad / total : 0,
      rateLimited429: limited,
      rate429: total ? limited / total : 0,
      unavailable503: unavailable,
      rate503: total ? unavailable / total : 0,
      timeouts,
      timeoutRate: total ? timeouts / total : 0,
      timeoutsByEndpoint,
      // decoded response bodies of the HTTP calls (a compressing proxy sends less on the wire;
      // WebSocket traffic is not counted)
      bytesReceived: bytes,
      bytesPerSecond: seconds > 0 ? Math.round(bytes / seconds) : null,
      endpoints,
    };
  }
}

// ── ramp schedules ────────────────────────────────────────────────────────────────
/**
 * Start offsets (ms after the run began) of `n` virtual users.
 *  linear : evenly spread over the ramp
 *  step   : 5 equal batches, one every ramp/5
 *  spike  : everybody at t=0 (a presale start)
 */
export function rampOffsets(n, rampMs, profile = 'linear') {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (profile === 'spike' || rampMs <= 0) out[i] = 0;
    else if (profile === 'step') out[i] = Math.floor((i * 5) / n) * (rampMs / 5);
    else if (profile === 'linear') out[i] = (i / Math.max(1, n)) * rampMs;
    else throw new Error(`unknown ramp profile "${profile}" (linear, step, spike)`);
  }
  return out;
}

/** Splits `total` users into `workers` contiguous slices {start,count} (sizes differ by at most 1). */
export function sliceUsers(total, workers) {
  const w = Math.max(1, Math.min(workers, total));
  const base = Math.floor(total / w);
  const extra = total % w;
  const out = [];
  let start = 0;
  for (let i = 0; i < w; i++) {
    const count = base + (i < extra ? 1 : 0);
    out.push({ start, count });
    start += count;
  }
  return out;
}

// ── exclusivity ───────────────────────────────────────────────────────────────────
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

function describeOverlap(seat, a, b, kind) {
  const side = (iv) => ({
    sid: iv.sid,
    from: iso(iv.from),
    to: iso(iv.to),
    releaseUnknown: Boolean(iv.toUnknown),
    releaseStatus: iv.releaseStatus ?? null,
    releaseCode: iv.releaseCode ?? null,
  });
  return { seat, kind, a, b, details: { seat, kind, a: side(a), b: side(b) } };
}

function scan(list, endOf) {
  const out = [];
  list.sort((x, y) => x.from - y.from);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[j].from >= endOf(list[i])) break; // sorted: later ones start even later
      if (list[i].sid !== list[j].sid) out.push([list[i], list[j]]);
    }
  }
  return out;
}

/**
 * Hold intervals {seat, sid, from, to, toUnknown?, releaseStatus?}: `from` = when the lock response
 * arrived (the seat was certainly held from then on), `to` = when the release request was SENT
 * (still certainly held until then), `toUnknown` = the release failed or timed out, so the server
 * may or may not have processed it (and may have done so after the client gave up).
 *
 * Two DIFFERENT sessions holding the same seat at the same time is a double booking, but only when
 * proven:
 *  - certain: the intervals overlap using the certain bounds only (`to` = release sent).
 *  - indeterminate: they overlap only if an unknown-outcome release is assumed never to have
 *    happened (end = infinity). Possibly a harness artefact, never a failure, but reported.
 * Returns { certain, indeterminate }, each a list of {seat, kind, a, b, details}.
 */
export function findOverlaps(intervals) {
  const bySeat = new Map();
  for (const iv of intervals) {
    const list = bySeat.get(iv.seat) ?? [];
    list.push(iv);
    bySeat.set(iv.seat, list);
  }
  const certain = [];
  const indeterminate = [];
  for (const [seat, list] of bySeat) {
    const proven = new Map(); // earlier interval -> certainly overlapping later intervals
    for (const [x, y] of scan(list, (iv) => iv.to)) {
      proven.set(x, (proven.get(x) ?? new Set()).add(y));
      certain.push(describeOverlap(seat, x, y, 'certain'));
    }
    for (const [x, y] of scan(list, (iv) => (iv.toUnknown ? Infinity : iv.to))) {
      if (proven.get(x)?.has(y)) continue;
      indeterminate.push(describeOverlap(seat, x, y, 'indeterminate'));
    }
  }
  return { certain, indeterminate };
}

// ── safety guard ──────────────────────────────────────────────────────────────────
const CLIENT_STACK_PORTS = new Set(['8080', '3000']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Validates the load test target. Returns {ok:true, url} or {ok:false, reason}. Refuses a missing
 * target, anything that is not http(s), and the default local shop / dev server ports on a local
 * host (the stack a developer or client is probably using).
 */
export function checkTarget(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, reason: '--target is required' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `--target "${raw}" is not a valid URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '--target must be an http(s) URL' };
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (LOCAL_HOSTS.has(url.hostname) && CLIENT_STACK_PORTS.has(port)) {
    return {
      ok: false,
      reason: `refusing ${url.host}: that is the default address of the regular stack / dev server`,
    };
  }
  return { ok: true, url };
}

/** True for private / LAN / link-local / unique-local IP literals and LAN-style host names. */
export function isPrivateHost(hostname) {
  const h = String(hostname)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(':')) return /^(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/.test(h);
  return /\.(local|lan|internal|home|corp|intranet)$/.test(h);
}

/**
 * Validates --database-url of a load run: a postgres URL whose host is not a private / LAN address
 * (an accidental run against a LAN client stack) unless `allowPrivate` (--allow-private) is given.
 * Loopback stays allowed (throwaway containers).
 */
export function checkDatabaseTarget(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: '--database-url is not a valid URL' };
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return { ok: false, reason: '--database-url must be a postgres:// URL' };
  }
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    return {
      ok: false,
      reason: `refusing the database host ${url.hostname}: it is a private / LAN address (pass --allow-private if this is a throwaway database)`,
    };
  }
  return { ok: true, url };
}

/** The load test token must look like what the admin page issues (base64url, 40+ chars). */
export function looksLikeToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,128}$/.test(token);
}

/** Removes a secret from a text (error messages, logs). */
export function redact(text, secret) {
  return secret ? String(text).split(secret).join('[token]') : String(text);
}

// ── small parsers ─────────────────────────────────────────────────────────────────
/** "90", "90s", "2m", "1h30m" -> milliseconds. */
export function parseDuration(value, fallbackMs) {
  if (value === undefined || value === true) return fallbackMs;
  const s = String(value).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)) {
    total += Number(m[1]) * { h: 3_600_000, m: 60_000, s: 1000 }[m[2]];
    matched += m[0];
  }
  if (!matched || matched !== s)
    throw new Error(`invalid duration "${value}" (e.g. 90s, 2m, 1h30m)`);
  return total;
}

/** Parses Prometheus text into {name{labels}: value} (numbers only). */
export function parsePrometheus(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    if (i < 0) continue;
    const value = Number(line.slice(i + 1));
    if (Number.isFinite(value)) out[line.slice(0, i)] = value;
  }
  return out;
}

/** Evaluates the pass / fail assertions of a finished run. Returns a list of {title, ok, detail}. */
export function evaluateAssertions({
  summary,
  overlaps,
  indeterminateOverlaps = [],
  limits,
  ledger,
  rt,
}) {
  const checks = [];
  const add = (title, ok, detail = '') => checks.push({ title, ok: Boolean(ok), detail });
  add(
    `no seat was certainly held by two sessions at the same time (${ledger.intervals} hold intervals checked)`,
    overlaps.length === 0,
    overlaps.length ? `${overlaps.length} overlaps, e.g. seat ${overlaps[0].seat}` : '',
  );
  if (indeterminateOverlaps.length > 0) {
    // Not a failure: only a release request that timed out (outcome unknown) makes these overlap.
    checks.push({
      title: 'indeterminate hold overlaps (a release request timed out or failed)',
      ok: true,
      warn: true,
      detail: `${indeterminateOverlaps.length} seat(s) were granted again while the previous holder's release outcome was unknown (e.g. seat ${indeterminateOverlaps[0].seat}); the server may have processed that release after the client gave up. Details in the JSON (indeterminateOverlaps).`,
    });
  }
  add(
    `5xx / network error rate <= ${(limits.maxFailureRate * 100).toFixed(1)} %`,
    summary.failureRate <= limits.maxFailureRate,
    `${(summary.failureRate * 100).toFixed(2)} % (${summary.failures5xxOrNetwork} of ${summary.requests})`,
  );
  add(
    `HTTP 429 rate <= ${(limits.max429Rate * 100).toFixed(1)} % (a higher rate means an IP limit distorted the test)`,
    summary.rate429 <= limits.max429Rate,
    `${(summary.rate429 * 100).toFixed(2)} % (${summary.rateLimited429} x 429)`,
  );
  add(
    `HTTP 503 rate <= ${(limits.max503Rate * 100).toFixed(1)} %`,
    summary.rate503 <= limits.max503Rate,
    `${(summary.rate503 * 100).toFixed(2)} % (${summary.unavailable503} x 503)`,
  );
  if (ledger.hotSeats !== undefined) {
    // Not vacuous: somebody won a hot seat AND others were refused (best available may take some
    // hot seats too, so "every hot seat was won by a hot request" is not required).
    add(
      'the hot seats were really contended (won at least once, refused to the others)',
      ledger.hotWon >= 1 && (ledger.hotContenders <= 1 || ledger.hotLost >= 1),
      `${ledger.hotWon} hot locks granted, ${ledger.hotLost} refused, ${ledger.hotSeats} hot seats, ${ledger.hotContenders} contenders`,
    );
  }
  if (rt && rt.connected > 0) {
    add(
      `realtime fan-out p95 <= ${limits.maxFanoutP95Ms} ms`,
      rt.p95 === null || rt.p95 <= limits.maxFanoutP95Ms,
      `p50 ${rt.p50} ms, p95 ${rt.p95} ms, p99 ${rt.p99} ms over ${rt.samples} deliveries`,
    );
  }
  return checks;
}

// ── server metrics sampled during the run ──────────────────────────────────────────
const NOTABLE_METRICS = [
  'tix_process_resident_memory_bytes',
  'tix_process_heap_used_bytes',
  'tix_postgres_connections',
  'tix_postgres_longest_query_seconds',
  'tix_redis_used_memory_bytes',
  'tix_redis_connected_clients',
  'tix_redis_ops_per_second',
  'tix_realtime_sockets',
  'tix_seat_locks',
  'tix_shop_sessions',
  'tix_db_pool_connections',
  'tix_db_pool_max',
  'tix_event_loop_lag_seconds',
  'tix_process_cpu_seconds_total',
  'tix_scrape_degraded',
];

/**
 * Folds one parsed /api/metrics sample into the running peaks (max per metric line, so per pid for
 * the per-process metrics) and adds the synthetic `tix_db_pool_in_use{pid}` (total - idle of the
 * same sample, so the peak is consistent). Mutates and returns `peaks`.
 */
export function foldMetricSample(peaks, parsed) {
  const bump = (k, v) => {
    peaks[k] = Math.max(peaks[k] ?? 0, v);
  };
  for (const [k, v] of Object.entries(parsed)) {
    if (NOTABLE_METRICS.some((n) => k.startsWith(n))) bump(k, v);
    const total = k.match(/^tix_db_pool_connections\{pid="([^"]*)",state="total"\}$/);
    if (total) {
      const idle = parsed[`tix_db_pool_connections{pid="${total[1]}",state="idle"}`] ?? 0;
      bump(`tix_db_pool_in_use{pid="${total[1]}"}`, Math.max(0, v - idle));
    }
  }
  return peaks;
}

const pidOf = (key) => key.match(/pid="([^"]*)"/)?.[1] ?? '?';

/**
 * Short plain-language hints derived from the run: where is the bottleneck? `scrapes` =
 * {ok, failed} counts of the sampled /api/metrics calls. Returns a list of lines (empty when the
 * timeout rate is below 1 %).
 */
export function diagnosisHints({ summary, peaks, scrapes }) {
  if (!(summary.timeoutRate > 0.01)) return [];
  const pct = (summary.timeoutRate * 100).toFixed(1);
  const lines = [
    `${summary.timeouts} of ${summary.requests} requests (${pct} %) timed out - where does the time go?`,
  ];
  const entries = Object.entries(peaks);
  const sampled = scrapes && scrapes.ok > 0 && entries.some(([k]) => k.startsWith('tix_db_pool'));
  if (!sampled) {
    lines.push(
      scrapes && scrapes.failed > 0 && scrapes.ok === 0
        ? `no server metrics could be sampled (${scrapes.failed} scrape(s) failed or timed out): the server or the network path was overloaded; check docker stats of ALL containers, top (iowait / steal) and the network path`
        : 'no server metrics were sampled (pass --metrics-token, server version with tix_db_pool_* metrics): cannot say whether the server was the bottleneck',
    );
    return lines;
  }
  let reasons = 0;
  const waiting = entries
    .filter(
      ([k, v]) => k.startsWith('tix_db_pool_connections') && k.includes('state="waiting"') && v > 0,
    )
    .sort((a, b) => b[1] - a[1]);
  if (waiting.length) {
    reasons++;
    lines.push(
      `DB pool: requests waited for a connection (peak ${waiting[0][1]} on process ${pidOf(waiting[0][0])}): raise WEB_DATABASE_POOL_MAX / the connection budget, or look at slow queries`,
    );
  }
  const lag = entries
    .filter(
      ([k, v]) =>
        k.startsWith('tix_event_loop_lag_seconds') && k.includes('quantile="0.99"') && v > 0.2,
    )
    .sort((a, b) => b[1] - a[1]);
  if (lag.length) {
    reasons++;
    lines.push(
      `event loop: p99 lag peaked at ${Math.round(lag[0][1] * 1000)} ms on process ${pidOf(lag[0][0])}: the web process is CPU bound, raise TIX_WEB_PROCESSES (or add CPU)`,
    );
  }
  if ((peaks.tix_scrape_degraded ?? 0) > 0) {
    reasons++;
    lines.push(
      'a metrics scrape needed more than 4 s for the database part: the database (or its connection pool) was saturated',
    );
  }
  if (!reasons) {
    lines.push(
      'not CPU/DB/event-loop bound as seen by the server: check network path (Cloudflare/Traefik/uplink)',
    );
  }
  return lines;
}

/**
 * Classifies the answer of the ENTER call: 'granted', 'queued' (the body really carries a waiting
 * room status), 'timeout' / 'network' (no answer, status 0), 'body_timeout' (status 200 but the body
 * did not arrive in time) or 'other'. Only 'queued' means the waiting room was active.
 */
export function classifyEnter(r) {
  if (r.status === 0) return r.code === 'TIMEOUT' ? 'timeout' : 'network';
  if (r.status === 200 && r.code === 'TIMEOUT') return 'body_timeout';
  const st = r.body?.status;
  if (r.status === 200 && st === 'GRANTED') return 'granted';
  if (r.status === 200 && ['QUEUED', 'LOBBY', 'NOT_STARTED', 'ADMITTED'].includes(st))
    return 'queued';
  return 'other';
}
