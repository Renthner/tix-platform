// Diagnostics of the journey load test (pure, no I/O except CpuSampler / helpers marked as such;
// unit tested in scripts/load/test/diag.test.mjs). Answers "WHICH component produced this status?":
// error samples with safe response headers, network error causes, Cloudflare path indicator,
// per-10-second timeline, generator CPU / event loop saturation and the resulting hints.
import os from 'node:os';
import { Histogram } from './stats.mjs';

export const SAMPLE_CAP = 3;
export const BUCKET_MS = 10_000;
export const CPU_SATURATED_PERCENT = 85;
export const LOOP_LAG_SATURATED_MS = 200;

/** Response headers that may be stored (never cookies / authorization / the loadtest header). */
const SAFE_HEADERS = new Set([
  'server',
  'via',
  'allow',
  'content-type',
  'content-length',
  'location',
  'retry-after',
  'x-request-id',
  'x-tix-upstream',
  'cf-ray',
  'cf-cache-status',
  'x-powered-by',
  'x-forwarded-server',
]);
const isSafeHeader = (name) => SAFE_HEADERS.has(name) || /traefik/.test(name);

const redactSecret = (text, secret) =>
  secret ? String(text).split(secret).join('[token]') : String(text);

/** Picks the safe subset (lower-case names) from a Headers object or a plain object. */
export function pickSafeHeaders(headers, secret = null) {
  const out = {};
  if (!headers) return out;
  const entries =
    typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [rawName, value] of entries) {
    const name = String(rawName).toLowerCase();
    if (!isSafeHeader(name)) continue;
    let v = String(value).slice(0, 200);
    if (name === 'location') v = v.split('?')[0]; // a redirect target must not leak query secrets
    out[name] = redactSecret(v, secret);
  }
  return out;
}

/** First 200 characters of a response body as one line of text (control characters removed). */
export function sanitizeBody(text, secret = null) {
  // eslint-disable-next-line no-control-regex
  const flat = String(text ?? '')
    .slice(0, 200)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return redactSecret(flat, secret);
}

/**
 * Underlying cause of a failed fetch: {cause, kind}. kind = 'harness-timeout' for our own abort
 * signal (the 30 s timeout), otherwise 'connection' (undici / socket level error).
 */
export function classifyNetworkError(err) {
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const c = err?.cause;
  const nested = Array.isArray(c?.errors) ? c.errors.map((e) => str(e?.code)).find(Boolean) : null;
  const code = str(c?.code) ?? nested ?? str(err?.code);
  const name = str(err?.name);
  if (!code && (name === 'TimeoutError' || name === 'AbortError')) {
    return { cause: 'TimeoutError', kind: 'harness-timeout' };
  }
  return {
    cause: code ?? str(c?.name) ?? name ?? 'UNKNOWN',
    kind: 'connection',
  };
}

const isUsefulStatus = (s) => (s >= 200 && s < 300) || s === 304 || s === 409;
const isErrorStatus = (s) => s === 0 || s >= 500 || (s >= 400 && s !== 409);

/** True when a stored sample looks like something the TIX app (or its small proxy page) sends. */
export function looksLikeAppResponse(sample) {
  if (sample.headers?.['x-tix-upstream']) return true;
  const body = String(sample.body ?? '');
  if (/^\s*\{/.test(body) && /"(code|message)"\s*:/.test(body)) return true;
  if (/ticket shop/i.test(body)) return true;
  return false;
}

const emptyBucket = () => ({ n: 0, errors: 0, timeouts: 0, hist: new Histogram(), active: 0 });

export class Diagnostics {
  constructor(runStart = Date.now(), { sampleCap = SAMPLE_CAP, bucketMs = BUCKET_MS } = {}) {
    this.runStart = runStart;
    this.sampleCap = sampleCap;
    this.bucketMs = bucketMs;
    this.samples = new Map(); // "<endpoint>:<status>" -> [sample]
    this.net = new Map(); // cause -> {n, kind, byEndpoint}
    this.via = { responses: 0, cfRay: 0, serverCloudflare: 0, cloudflare: 0 };
    this.addresses = new Map(); // remote address -> connections
    this.buckets = new Map(); // index -> bucket
  }
  bucket(wall) {
    const i = Math.max(0, Math.floor((wall - this.runStart) / this.bucketMs));
    let b = this.buckets.get(i);
    if (!b) {
      b = emptyBucket();
      this.buckets.set(i, b);
    }
    return b;
  }
  /**
   * One finished call: {label, method, path, status, ms, wallEnd, headers, text, err, code, secret}.
   * `headers` is a Headers object / plain object (only a safe subset is kept), `err` the caught error.
   */
  observe(o) {
    const status = o.status ?? 0;
    const wallEnd = o.wallEnd ?? Date.now();
    const timedOut = o.code === 'TIMEOUT';
    const b = this.bucket(wallEnd);
    b.n++;
    b.hist.record(o.ms ?? 0);
    if (isErrorStatus(status) || timedOut) b.errors++;
    if (timedOut) b.timeouts++;
    if (status > 0) {
      this.via.responses++;
      const h = o.headers;
      const get = (n) => (h?.get ? h.get(n) : h?.[n]);
      const ray = Boolean(get('cf-ray'));
      const srv = /cloudflare/i.test(String(get('server') ?? ''));
      if (ray) this.via.cfRay++;
      if (srv) this.via.serverCloudflare++;
      if (ray || srv) this.via.cloudflare++;
      if (!isUsefulStatus(status)) {
        const key = `${o.label}:${status}`;
        const list = this.samples.get(key) ?? [];
        if (list.length < this.sampleCap) {
          list.push({
            endpoint: o.label,
            status,
            method: o.method,
            path: String(o.path ?? '').split('?')[0],
            headers: pickSafeHeaders(h, o.secret),
            body: sanitizeBody(o.text, o.secret),
            ms: Math.round((o.ms ?? 0) * 10) / 10,
            atMs: Math.max(0, wallEnd - this.runStart),
          });
          this.samples.set(key, list);
        }
      }
    }
    if (o.err) {
      const { cause, kind } = classifyNetworkError(o.err);
      const e = this.net.get(cause) ?? { n: 0, kind, byEndpoint: {} };
      e.n++;
      e.byEndpoint[o.label] = (e.byEndpoint[o.label] ?? 0) + 1;
      this.net.set(cause, e);
    }
  }
  noteActive(n, at = Date.now()) {
    const b = this.bucket(at);
    if (n > b.active) b.active = n;
  }
  noteAddress(addr) {
    if (addr) this.addresses.set(addr, (this.addresses.get(addr) ?? 0) + 1);
  }
  merge(other) {
    for (const [k, list] of other.samples) {
      const mine = this.samples.get(k) ?? [];
      const merged = [...mine, ...list].sort((a, c) => a.atMs - c.atMs).slice(0, this.sampleCap);
      this.samples.set(k, merged);
    }
    for (const [cause, o] of other.net) {
      const e = this.net.get(cause) ?? { n: 0, kind: o.kind, byEndpoint: {} };
      e.n += o.n;
      for (const [ep, v] of Object.entries(o.byEndpoint))
        e.byEndpoint[ep] = (e.byEndpoint[ep] ?? 0) + v;
      this.net.set(cause, e);
    }
    for (const k of Object.keys(this.via)) this.via[k] += other.via[k] ?? 0;
    for (const [a, n] of other.addresses) this.addresses.set(a, (this.addresses.get(a) ?? 0) + n);
    for (const [i, o] of other.buckets) {
      let b = this.buckets.get(i);
      if (!b) {
        b = emptyBucket();
        this.buckets.set(i, b);
      }
      b.n += o.n;
      b.errors += o.errors;
      b.timeouts += o.timeouts;
      b.active += o.active; // sum of the per-process peaks
      b.hist.merge(o.hist);
    }
    return this;
  }
  toJSON() {
    return {
      runStart: this.runStart,
      sampleCap: this.sampleCap,
      bucketMs: this.bucketMs,
      samples: [...this.samples],
      net: [...this.net],
      via: this.via,
      addresses: [...this.addresses],
      buckets: [...this.buckets].map(([i, b]) => [i, { ...b, hist: b.hist.toJSON() }]),
    };
  }
  static fromJSON(j) {
    const d = new Diagnostics(j.runStart, { sampleCap: j.sampleCap, bucketMs: j.bucketMs });
    d.samples = new Map(j.samples);
    d.net = new Map(j.net);
    d.via = { ...j.via };
    d.addresses = new Map(j.addresses);
    d.buckets = new Map(j.buckets.map(([i, b]) => [i, { ...b, hist: Histogram.fromJSON(b.hist) }]));
    return d;
  }
  errorSamples() {
    return [...this.samples.values()].flat().sort((a, b) => a.atMs - b.atMs);
  }
  networkErrorCauses() {
    const causes = {};
    let harnessTimeouts = 0;
    let connectionErrors = 0;
    for (const [cause, e] of [...this.net].sort((a, b) => b[1].n - a[1].n)) {
      causes[cause] = { count: e.n, kind: e.kind, byEndpoint: e.byEndpoint };
      if (e.kind === 'harness-timeout') harnessTimeouts += e.n;
      else connectionErrors += e.n;
    }
    return { harnessTimeouts, connectionErrors, causes };
  }
  pathIndicator({ ipv4Only = false } = {}) {
    return {
      ...this.via,
      ipv4Only,
      remoteAddresses: [...this.addresses]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([address, connections]) => ({ address, connections })),
      distinctRemoteAddresses: this.addresses.size,
    };
  }
  timeline() {
    const max = Math.max(-1, ...this.buckets.keys());
    const rows = [];
    for (let i = 0; i <= max; i++) {
      const b = this.buckets.get(i);
      rows.push({
        fromS: (i * this.bucketMs) / 1000,
        toS: ((i + 1) * this.bucketMs) / 1000,
        requests: b?.n ?? 0,
        errors: b?.errors ?? 0,
        p95Ms: b && b.n ? Math.round((b.hist.percentile(95) ?? 0) * 10) / 10 : null,
        timeouts: b?.timeouts ?? 0,
        activeShoppers: b?.active ?? 0,
      });
    }
    return rows;
  }
}

// ── generator CPU ─────────────────────────────────────────────────────────────────

/** Sum of idle / total CPU ticks of os.cpus()-shaped data. */
export function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const [k, v] of Object.entries(c.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

/** CPU busy percent between two cpuTotals() snapshots (null when no ticks elapsed). */
export function cpuPercent(a, b) {
  const total = b.total - a.total;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / total) * 100));
}

export function summarizeCpu(percents) {
  const list = percents.filter((p) => p !== null && Number.isFinite(p));
  if (!list.length) return { samples: 0, avgPercent: null, peakPercent: null, saturated: false };
  const avg = list.reduce((s, v) => s + v, 0) / list.length;
  const peak = Math.max(...list);
  return {
    samples: list.length,
    avgPercent: Math.round(avg * 10) / 10,
    peakPercent: Math.round(peak * 10) / 10,
    saturated: peak > CPU_SATURATED_PERCENT,
  };
}

/** Samples the overall CPU load of this machine every `intervalMs` (I/O: os.cpus). */
export class CpuSampler {
  constructor(intervalMs = 2000) {
    this.intervalMs = intervalMs;
    this.percents = [];
    this.timer = null;
    this.last = null;
  }
  start() {
    this.last = cpuTotals(os.cpus());
    this.timer = setInterval(() => {
      const cur = cpuTotals(os.cpus());
      this.percents.push(cpuPercent(this.last, cur));
      this.last = cur;
    }, this.intervalMs);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return summarizeCpu(this.percents);
  }
}

/** Per-worker event loop lag [{p99Ms, peakP99Ms}] -> {peakP99Ms, saturated}. */
export function summarizeLoopLag(workers) {
  const peak = Math.max(0, ...workers.map((w) => w?.peakP99Ms ?? 0));
  return {
    workers: workers.length,
    peakP99Ms: Math.round(peak * 10) / 10,
    perWorkerPeakP99Ms: workers.map((w) => Math.round((w?.peakP99Ms ?? 0) * 10) / 10),
    saturated: peak > LOOP_LAG_SATURATED_MS,
  };
}

// ── hints ─────────────────────────────────────────────────────────────────────────

/**
 * Plain-language hints from the new diagnostics. `generator` = {cpu, loopLag}. Returns lines.
 */
export function diagnoseDiagnostics({ diag, generator = null }) {
  const lines = [];
  const via = diag.via;
  if (via.cloudflare > 0) {
    lines.push(
      `part of the traffic went through Cloudflare (${via.cloudflare} of ${via.responses} responses carry cf-ray / server: cloudflare): the hosts-file entry was not used for every connection (check IPv6 / AAAA, DNS cache, DoH in the OS)`,
    );
  }
  for (const s of diag.errorSamples()) {
    if (![405, 502, 504].includes(s.status)) continue;
    if (looksLikeAppResponse(s)) continue;
    const key = `${s.endpoint}:${s.status}`;
    if (lines.some((l) => l.startsWith(`status ${s.status} was not produced`) && l.includes(key))) {
      continue;
    }
    const h = [
      s.headers.server && `server: ${s.headers.server}`,
      s.headers.via && `via: ${s.headers.via}`,
      s.headers['cf-ray'] && `cf-ray: ${s.headers['cf-ray']}`,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `status ${s.status} was not produced by the TIX app (${key}; header ${h || 'none of server/via'} / body "${s.body.slice(0, 80)}"): check Traefik / the network device in front`,
    );
  }
  if (generator?.cpu?.saturated) {
    lines.push('generator CPU is saturated: results are limited by the load generator');
  } else if (generator?.loopLag?.saturated) {
    lines.push(
      `generator event loop is saturated (p99 lag peaked at ${generator.loopLag.peakP99Ms} ms in a worker): results are limited by the load generator, use more --workers or a stronger machine`,
    );
  }
  return lines;
}
