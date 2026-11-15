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
  record(label, status, code, ms) {
    let m = this.labels.get(label);
    if (!m) {
      m = { n: 0, statuses: {}, codes: {}, hist: new Histogram(), bad: 0 };
      this.labels.set(label, m);
    }
    m.n++;
    m.statuses[status] = (m.statuses[status] ?? 0) + 1;
    if (code) {
      const k = `${status}:${code}`;
      m.codes[k] = (m.codes[k] ?? 0) + 1;
    }
    if (status === 0 || status >= 500) m.bad++;
    m.hist.record(ms);
  }
  merge(other) {
    for (const [label, o] of other.labels) {
      let m = this.labels.get(label);
      if (!m) {
        m = { n: 0, statuses: {}, codes: {}, hist: new Histogram(), bad: 0 };
        this.labels.set(label, m);
      }
      m.n += o.n;
      m.bad += o.bad;
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
    for (const [label, m] of [...this.labels].sort((a, b) => a[0].localeCompare(b[0]))) {
      total += m.n;
      bad += m.bad;
      limited += m.statuses[429] ?? 0;
      unavailable += m.statuses[503] ?? 0;
      endpoints[label] = {
        requests: m.n,
        p50: round1(m.hist.percentile(50)),
        p95: round1(m.hist.percentile(95)),
        p99: round1(m.hist.percentile(99)),
        max: round1(m.hist.max),
        statuses: m.statuses,
        codes: m.codes,
        failures5xxOrNetwork: m.bad,
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
/**
 * Hold intervals {seat, sid, from, to}: `from` = when the lock response arrived (the seat was
 * certainly held from then on), `to` = when the release request was sent (still certainly held),
 * Infinity when the holder never released. Two DIFFERENT sessions certainly holding the same seat
 * at the same time is a double booking. Returns the violating pairs.
 */
export function findOverlaps(intervals) {
  const bySeat = new Map();
  for (const iv of intervals) {
    const list = bySeat.get(iv.seat) ?? [];
    list.push(iv);
    bySeat.set(iv.seat, list);
  }
  const violations = [];
  for (const [seat, list] of bySeat) {
    list.sort((a, b) => a.from - b.from);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].from >= list[i].to) break; // sorted: later ones start even later
        if (list[i].sid !== list[j].sid) violations.push({ seat, a: list[i], b: list[j] });
      }
    }
  }
  return violations;
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
export function evaluateAssertions({ summary, overlaps, limits, ledger, rt }) {
  const checks = [];
  const add = (title, ok, detail = '') => checks.push({ title, ok: Boolean(ok), detail });
  add(
    `no seat was held by two sessions at the same time (${ledger.intervals} hold intervals checked)`,
    overlaps.length === 0,
    overlaps.length ? `${overlaps.length} overlaps, e.g. seat ${overlaps[0].seat}` : '',
  );
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
