// Building blocks shared by the scenarios: virtual user set-up, warm-up barrier, seat ledger and
// realtime observers.
import { Metrics, Vu, keyspace, now, pool, sleep, socketIo } from './common.mjs';
import { readRedisState } from './invariants.mjs';

/** seatId -> virtual users that currently hold it according to the HTTP responses. */
export class Ledger {
  constructor() {
    this.map = new Map();
  }
  add(seat, vu) {
    const list = this.map.get(seat) ?? [];
    list.push(vu);
    this.map.set(seat, list);
  }
  remove(seat, vu) {
    const list = (this.map.get(seat) ?? []).filter((v) => v !== vu);
    if (list.length) this.map.set(seat, list);
    else this.map.delete(seat);
  }
}

/**
 * Creates the virtual users and performs the warm-up: every user gets a session cookie and a
 * queue pass (POST /enter). Returns once all users are ready at the "starting line".
 * Warm-up and rush are measured in separate Metrics objects.
 */
export async function prepareVus(ctx, count = ctx.cfg.vus) {
  const { cfg, eventId } = ctx;
  const warm = new Metrics();
  const rush = new Metrics();
  const vus = Array.from({ length: count }, (_, i) => new Vu(cfg, i, warm));
  const t0 = now();
  await pool(vus, cfg.warmupConcurrency, async (vu) => {
    await vu.call('ENTER', 'POST', `/api/events/${eventId}/enter`);
  });
  ctx.log(`warm-up: ${count} sessions entered in ${Math.round(now() - t0)} ms`);
  return { vus, warm, rush };
}

/** Starts all users at the same moment (single synchronous release of the barrier). */
export async function releaseTogether(vus, rushMetrics, body) {
  let release;
  const gate = new Promise((r) => (release = r));
  for (const vu of vus) vu.metrics = rushMetrics;
  const running = vus.map(async (vu, i) => {
    await gate;
    return body(vu, i);
  });
  const t0 = now();
  release();
  await Promise.all(running);
  return now() - t0;
}

export async function releaseSeats(ctx, vu, ledger, seats) {
  const r = await vu.call('UNLOCK', 'DELETE', `/api/events/${ctx.eventId}/seats`, {
    seatIds: seats,
  });
  if (r.status === 200) for (const s of seats) ledger.remove(s, vu.id);
  return r.status === 200;
}

// ── realtime observers ────────────────────────────────────────────────────────────
/** Opens `count` Socket.io clients that mirror seat deltas; used to verify convergence. */
export async function startObservers(ctx, count) {
  const { cfg, eventId, metrics } = ctx;
  // seats sold / blocked / removed before the rush are not part of the deltas observers see
  ctx.initialTaken = new Set(
    Object.keys(await ctx.redis.hgetall(keyspace(cfg.prefix, eventId).taken)),
  );
  if (count <= 0) return { observers: [], close() {}, connected: 0, failed: 0 };
  const io = socketIo();
  const observers = [];
  let failed = 0;
  const m = new Metrics();
  const vus = Array.from({ length: count }, (_, i) => new Vu(cfg, 2_000_000 + i, m));
  await pool(vus, 100, async (vu) => {
    await vu.call('RT_SESSION', 'POST', `/api/events/${eventId}/enter`);
    const res = await vu.call('RT_TOKEN', 'GET', '/api/session/realtime-token');
    const token = res.body?.token;
    if (!token) return void failed++;
    const view = new Map();
    const state = { view, deltas: 0, connected: false };
    const socket = io(cfg.base, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token },
      extraHeaders: cfg.fakeIp ? { 'x-forwarded-for': vu.ip } : {},
      reconnection: false,
    });
    state.socket = socket;
    socket.on('seats:delta', (d) => {
      state.deltas++;
      for (const [id, status] of d.seats) {
        if (status === 'F') view.delete(id);
        else view.set(id, status);
      }
    });
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 15_000);
      socket.on('connect', () => {
        clearTimeout(t);
        state.connected = true;
        socket.emit('seats:subscribe', eventId);
        resolve(true);
      });
      socket.on('connect_error', () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    if (ok) observers.push(state);
    else {
      failed++;
      socket.close();
    }
  });
  await sleep(500);
  metrics?.count('observers_connected', observers.length);
  ctx.log(`realtime observers: ${observers.length} connected, ${failed} failed`);
  return {
    observers,
    failed,
    connected: observers.length,
    close() {
      for (const o of observers) o.socket.close();
    },
  };
}

/** Polls until every observer's view equals the Redis truth (or timeout). */
export async function observerConvergence(ctx, observers, timeoutMs = 20_000) {
  const t0 = now();
  let bad = observers.length;
  let lastTruthSize = 0;
  while (now() - t0 < timeoutMs) {
    const st = await readRedisState(ctx.redis, ctx.cfg.prefix, ctx.eventId);
    const truth = new Map();
    for (const id of st.locks.keys()) truth.set(id, 'L');
    for (const [id, s] of Object.entries(st.taken))
      if (!ctx.initialTaken.has(id)) truth.set(id, s === 'B' ? 'B' : 'S');
    lastTruthSize = truth.size;
    bad = 0;
    for (const o of observers) {
      let same = o.view.size === truth.size;
      if (same) for (const [id, s] of truth) if (o.view.get(id) !== s) same = false;
      if (!same) bad++;
    }
    if (bad === 0) return { converged: true, ms: Math.round(now() - t0), mismatching: 0 };
    await sleep(250);
  }
  const o = observers[0];
  return {
    converged: false,
    ms: Math.round(now() - t0),
    mismatching: bad,
    sample: o ? { view: o.view.size, deltas: o.deltas, truth: lastTruthSize } : null,
  };
}
