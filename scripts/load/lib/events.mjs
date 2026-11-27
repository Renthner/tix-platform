// Multi-event building blocks of the journey load test (pure, unit tested in scripts/load/test):
// parsing / validation of the event list, weights and multi-event ratio, the deterministic
// shopper -> primary event assignment, and the per-event breakdown (merge, leaks, hot-seat check).

export const MAX_EVENTS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// fractional part of the golden ratio: a low-discrepancy sequence over the virtual user ids
const GOLDEN = (Math.sqrt(5) - 1) / 2;

const list = (raw) =>
  String(raw)
    .split(',')
    .map((s) => s.trim());

/** Upper limit of generator processes. */
export const MAX_WORKERS = 8;

/**
 * Number of generator processes. An explicit `--workers` is kept (clamped to 1..8). The default is
 * min(cpus, ceil(vus / 250)), raised to the number of events so the fan-out probe (process `w`
 * probes event `w mod n`) covers every event, capped at 8.
 */
export function resolveWorkers(arg, { cpus, vus, eventCount }) {
  const clamp = (n) => Math.max(1, Math.min(MAX_WORKERS, Math.floor(n)));
  const explicit = arg === undefined || arg === null || arg === true ? NaN : Number(arg);
  if (Number.isFinite(explicit)) return clamp(explicit);
  return clamp(Math.max(Math.min(cpus, Math.ceil(vus / 250)), eventCount));
}

/**
 * Parses `--event-id` (comma-separated, 1..20 distinct UUIDs) and the optional `--event-slug`
 * (comma-separated, same length, positional). Returns {ok:true, events:[{eventId, eventSlug}]} or
 * {ok:false, reason}.
 */
export function parseEventList(idArg, slugArg) {
  if (typeof idArg !== 'string' || !idArg.trim()) {
    return { ok: false, reason: '--event-id <uuid>[,<uuid>...] is required' };
  }
  const ids = list(idArg);
  if (ids.length > MAX_EVENTS) {
    return { ok: false, reason: `--event-id: at most ${MAX_EVENTS} events (got ${ids.length})` };
  }
  for (const id of ids) {
    if (!UUID.test(id)) return { ok: false, reason: `--event-id: "${id}" is not a UUID` };
  }
  const seen = new Set();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) return { ok: false, reason: `--event-id: ${id} is listed twice` };
    seen.add(key);
  }
  let slugs = ids.map(() => null);
  if (slugArg !== undefined) {
    if (typeof slugArg !== 'string' || !slugArg.trim()) {
      return { ok: false, reason: '--event-slug needs a value' };
    }
    const given = list(slugArg);
    if (given.length !== ids.length) {
      return {
        ok: false,
        reason: `--event-slug: ${given.length} slug(s) for ${ids.length} event(s); give one slug per event id, in the same order`,
      };
    }
    if (given.some((s) => !s)) return { ok: false, reason: '--event-slug: empty slug in the list' };
    slugs = given;
  }
  return { ok: true, events: ids.map((eventId, i) => ({ eventId, eventSlug: slugs[i] })) };
}

/**
 * Parses `--event-weights` (comma-separated positive numbers, one per event). Undefined = even
 * split (returns {ok:true, weights:null}).
 */
export function parseEventWeights(arg, n) {
  if (arg === undefined) return { ok: true, weights: null };
  if (typeof arg !== 'string' || !arg.trim()) {
    return { ok: false, reason: '--event-weights needs a value, e.g. 3,1,1' };
  }
  const weights = list(arg).map((s) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN));
  if (weights.length !== n) {
    return {
      ok: false,
      reason: `--event-weights: ${weights.length} weight(s) for ${n} event(s); give one per event id`,
    };
  }
  if (weights.some((w) => !(w > 0) || !Number.isFinite(w))) {
    return { ok: false, reason: '--event-weights: every weight must be a positive number' };
  }
  return { ok: true, weights };
}

/** Parses `--multi-event-ratio` (0..1). Default 0.1 with more than one event; always 0 with one. */
export function parseMultiEventRatio(arg, n) {
  if (arg === undefined) return { ok: true, ratio: n > 1 ? 0.1 : 0 };
  if (typeof arg !== 'string' || !/^\d+(\.\d+)?$/.test(arg.trim())) {
    return { ok: false, reason: '--multi-event-ratio needs a number between 0 and 1' };
  }
  const ratio = Number(arg);
  if (ratio > 1) return { ok: false, reason: '--multi-event-ratio must be between 0 and 1' };
  return { ok: true, ratio: n > 1 ? ratio : 0 };
}

/**
 * Primary event (index) of the virtual user `id` among `n` events. Without weights an even
 * round robin (`id % n`); with weights a deterministic proportional split: the golden-ratio
 * sequence frac(id * phi) is spread evenly over [0, 1) and mapped onto the cumulative weights.
 */
export function assignEvent(id, n, weights = null) {
  if (n <= 1) return 0;
  if (!weights) return id % n;
  const total = weights.reduce((a, b) => a + b, 0);
  const x = ((id * GOLDEN) % 1) * total;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += weights[i];
    if (x < acc) return i;
  }
  return n - 1;
}

/** Empty per-event counters of a worker (hot seats won as a list for JSON / IPC). */
export function emptyEventStats() {
  return {
    shoppers: 0,
    hotAttempts: 0,
    hotWon: 0,
    hotLost: 0,
    hotWonSeats: [],
    coldLocks: 0,
    bestAvailableOk: 0,
    checkoutsOk: 0,
    multiEventCarts: 0,
  };
}

/** Sums the per-event arrays of all workers (`parts` = list of arrays of emptyEventStats()). */
export function mergeEventStats(n, parts) {
  const out = Array.from({ length: n }, () => ({ ...emptyEventStats(), hotWonSeats: new Set() }));
  for (const part of parts) {
    for (let i = 0; i < n; i++) {
      const p = part?.[i];
      if (!p) continue;
      const o = out[i];
      for (const k of Object.keys(o)) if (k !== 'hotWonSeats') o[k] += p[k] ?? 0;
      for (const s of p.hotWonSeats ?? []) o.hotWonSeats.add(s);
    }
  }
  return out;
}

/**
 * Leaked locks per event: seats locked after the run that were not locked before. `events` =
 * [{eventId, lockedBefore: Set|array, lockedAfter: Set|array}]. Returns {total, perEvent:
 * [{eventId, leaked}], detail}.
 */
export function leakReport(events) {
  const perEvent = events.map((e) => {
    const before = new Set(e.lockedBefore ?? []);
    return {
      eventId: e.eventId,
      leaked: [...new Set(e.lockedAfter ?? [])].filter((s) => !before.has(s)).length,
    };
  });
  const total = perEvent.reduce((a, e) => a + e.leaked, 0);
  let detail = `${total} seats still held${total ? ' (carts that could not be cleared expire by TTL)' : ''}`;
  if (events.length > 1 && total) {
    detail += `; events: ${perEvent
      .filter((e) => e.leaked)
      .map((e) => `${e.eventId} (${e.leaked})`)
      .join(', ')}`;
  }
  return { total, perEvent, detail };
}

/**
 * Per-event hot-seat contention (only meaningful with more than one event): every event's hot
 * seats were won at least once AND refused at least once (unless the event had at most one
 * shopper). `events` = [{eventId, shoppers, hotSeats, hotWon, hotLost}]. Returns {title, ok,
 * detail}.
 */
export function perEventHotCheck(events) {
  const failing = events.filter((e) => !(e.hotWon >= 1 && (e.shoppers <= 1 || e.hotLost >= 1)));
  const fmt = (e) =>
    `${e.eventId}: ${e.hotWon} won, ${e.hotLost} refused, ${e.hotSeats} hot seats, ${e.shoppers} shoppers`;
  return {
    title:
      "every event's hot seats were contended (won at least once and refused at least once per event)",
    ok: failing.length === 0,
    detail: failing.length
      ? `not contended: ${failing.map(fmt).join('; ')} (each event needs clearly more shoppers than --hot)`
      : `${events.length} events contended`,
  };
}
