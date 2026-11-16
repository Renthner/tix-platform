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
    /** concurrent upstream requests per child and request class (missing class = unlimited) */
    this.limits = opts.limits ?? {};
    this.children = ports.map((port) => ({
      port,
      inflight: 0,
      failures: 0,
      downUntil: 0,
      lastFailAt: 0,
      ready: true,
      /** per request class: inflight (running + queued), active (running), queue, counters */
      classes: {},
    }));
    this.cursor = 0;
  }

  classState(i, cls) {
    const c = this.children[i];
    return (c.classes[cls] ??= { inflight: 0, active: 0, queue: [], served: 0, busy503: 0 });
  }

  /**
   * Takes one of the child's slots for the class. Returns an entry; `entry.granted` is true when the
   * slot is held right away. Otherwise the entry waits in the class queue: set `entry.onGrant` to be
   * called when a slot frees up. `entry.release()` is idempotent: it frees a held slot (and hands it
   * to the next waiter) or removes a waiting entry from the queue.
   */
  acquire(i, cls) {
    const s = this.classState(i, cls);
    const limit = this.limits[cls] ?? Infinity;
    const entry = { state: 'queued', granted: false, onGrant: null };
    entry.release = () => {
      if (entry.state === 'queued') {
        const at = s.queue.indexOf(entry);
        if (at >= 0) s.queue.splice(at, 1);
      } else if (entry.state === 'active') {
        s.active -= 1;
      } else {
        return;
      }
      entry.state = 'done';
      this.#drain(s, limit);
    };
    if (s.active < limit) {
      entry.state = 'active';
      entry.granted = true;
      s.active += 1;
      s.served += 1;
    } else {
      s.queue.push(entry);
    }
    return entry;
  }

  #drain(s, limit) {
    while (s.active < limit && s.queue.length) {
      const next = s.queue.shift();
      next.state = 'active';
      next.granted = true;
      s.active += 1;
      s.served += 1;
      next.onGrant?.();
    }
  }

  /** A request of the class was answered 503 BUSY because it waited too long for a slot. */
  noteBusy(i, cls) {
    this.classState(i, cls).busy503 += 1;
  }

  /** Per child counters (for the loopback-only detailed health answer). */
  stats() {
    return this.children.map((c, i) => ({
      index: i,
      port: c.port,
      ready: c.ready,
      inflight: c.inflight,
      classes: Object.fromEntries(
        Object.entries(c.classes).map(([name, s]) => [
          name,
          {
            limit: this.limits[name] ?? null,
            inflight: s.inflight,
            active: s.active,
            queued: s.queue.length,
            served: s.served,
            busy503: s.busy503,
          },
        ]),
      ),
    }));
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
   * With a request class the child with the fewest requests of THAT class in flight (running and
   * queued) wins; the total in flight breaks ties.
   * @param {Set<number>} [exclude]
   * @param {string} [cls]
   */
  pick(exclude, cls) {
    const n = this.children.length;
    let best = -1;
    const load = (i) => (cls ? (this.children[i].classes[cls]?.inflight ?? 0) : 0);
    const less = (a, b) =>
      load(a) < load(b) ||
      (load(a) === load(b) && this.children[a].inflight < this.children[b].inflight);
    for (let k = 0; k < n; k++) {
      const i = (this.cursor + k) % n;
      if (exclude?.has(i) || !this.children[i].ready || this.isDown(i)) continue;
      if (best < 0 || less(i, best)) best = i;
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

  begin(i, cls) {
    this.children[i].inflight += 1;
    if (cls) this.classState(i, cls).inflight += 1;
  }

  end(i, cls) {
    const c = this.children[i];
    if (c.inflight > 0) c.inflight -= 1;
    if (cls) {
      const s = this.classState(i, cls);
      if (s.inflight > 0) s.inflight -= 1;
    }
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
