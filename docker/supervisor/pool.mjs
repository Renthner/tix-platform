// Upstream pool of the web processes behind the built-in proxy.
//
// Selection: the child with the fewest requests in flight; ties are broken round-robin (a rotating
// cursor), so sequential traffic spreads evenly while a child stuck in a slow request (PDF, export)
// receives less. Children are only marked DOWN on a refused connection (nothing listens there: the
// process is starting, restarting or dead); a timeout or a reset never marks a healthy child down.
// A down child is skipped for a short, growing backoff, and is still tried when every child is down
// (the marks may be stale).
//
// Readiness (optional, driven by the supervisor): setReady(i, false) when the process exits and
// setReady(i, true) after its first successful health check. A child that is not ready is skipped
// like a down one, so live traffic never tests a crash-looping process. Without any setReady call
// every child counts as ready (standalone use, tests).
export class UpstreamPool {
  /**
   * @param {number[]} ports
   * @param {{ now?: () => number, backoffMs?: number, maxBackoffMs?: number }} [opts]
   */
  constructor(ports, opts = {}) {
    if (!ports.length) throw new Error('UpstreamPool needs at least one port');
    this.now = opts.now ?? Date.now;
    this.backoffMs = opts.backoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5_000;
    this.children = ports.map((port) => ({
      port,
      inflight: 0,
      failures: 0,
      downUntil: 0,
      lastFailAt: 0,
      ready: true,
    }));
    this.cursor = 0;
  }

  get size() {
    return this.children.length;
  }

  get ports() {
    return this.children.map((c) => c.port);
  }

  isDown(i) {
    const c = this.children[i];
    return c.failures > 0 && c.downUntil > this.now();
  }

  /** The supervisor knows whether process `i` is running and healthy. */
  setReady(i, ready) {
    const c = this.children[i];
    c.ready = Boolean(ready);
    if (c.ready) {
      c.failures = 0;
      c.downUntil = 0;
    }
  }

  isReady(i) {
    return this.children[i].ready;
  }

  /** True when every child is down or not ready (-> the "Starting" page). */
  allDown() {
    return this.children.every((c, i) => !c.ready || this.isDown(i));
  }

  /**
   * Index of the child to use, or null when `exclude` leaves nothing. Ready children that are not
   * down win; when none is left, the one that failed longest ago is tried (the marks may be stale).
   * @param {Set<number>} [exclude]
   */
  pick(exclude) {
    const n = this.children.length;
    let best = -1;
    for (let k = 0; k < n; k++) {
      const i = (this.cursor + k) % n;
      if (exclude?.has(i) || !this.children[i].ready || this.isDown(i)) continue;
      if (best < 0 || this.children[i].inflight < this.children[best].inflight) best = i;
    }
    if (best < 0) {
      for (let k = 0; k < n; k++) {
        const i = (this.cursor + k) % n;
        if (exclude?.has(i)) continue;
        if (best < 0 || this.children[i].lastFailAt < this.children[best].lastFailAt) best = i;
      }
    }
    if (best < 0) return null;
    this.cursor = (best + 1) % n;
    return best;
  }

  begin(i) {
    this.children[i].inflight += 1;
  }

  end(i) {
    const c = this.children[i];
    if (c.inflight > 0) c.inflight -= 1;
  }

  /** The connection to child `i` was refused. */
  markDown(i) {
    const c = this.children[i];
    c.failures += 1;
    c.lastFailAt = this.now();
    const delay = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (c.failures - 1));
    c.downUntil = this.now() + delay;
  }

  /** Child `i` answered: it is up. */
  markUp(i) {
    const c = this.children[i];
    c.failures = 0;
    c.downUntil = 0;
  }
}

/**
 * Aggregated state of the web processes from their /api/health status codes: healthy as long as at
 * least one answers 200 (the proxy skips the others).
 */
export function summarizeWebHealth(statuses) {
  const ready = statuses.filter((s) => s === 200).length;
  return { ready, total: statuses.length, component: ready > 0 ? 'ok' : 'down' };
}
