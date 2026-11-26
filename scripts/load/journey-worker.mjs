// Worker process of the journey load test (forked by journey.mjs). Runs a slice of the virtual
// users with realistic journeys and streams its results back over IPC. Not meant to be started
// by hand.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  Vu,
  applyIpv4Only,
  pick,
  rng,
  shuffle,
  sleep,
  socketIo,
  subscribeConnections,
} from './lib/common.mjs';
import { Diagnostics } from './lib/diag.mjs';
import { assignEvent, emptyEventStats } from './lib/events.mjs';
import { EndpointStats, Histogram, classifyEnter, rampOffsets } from './lib/stats.mjs';

process.on('message', (msg) => {
  if (msg?.type === 'start') {
    run(msg).catch((err) => {
      process.send({ type: 'error', message: String(err?.stack ?? err).slice(0, 2000) });
      process.exit(2);
    });
  } else if (msg?.type === 'stop') {
    stopping = true;
  }
});

let stopping = false;

async function run(m) {
  const { cfg, events, slice, plan } = m;
  const perEvent = events.map(() => ({ ...emptyEventStats(), hotWonSeats: new Set() }));
  applyIpv4Only(cfg);
  const stats = new EndpointStats();
  const diag = new Diagnostics(m.runStart ?? Date.now());
  subscribeConnections((a) => diag.noteAddress(a));
  // event loop lag of this process: a saturated generator distorts every latency it measures
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let peakLagP99Ms = 0;
  const sampleLoop = () => {
    peakLagP99Ms = Math.max(peakLagP99Ms, loop.percentile(99) / 1e6);
    loop.reset();
  };
  const fanout = new Histogram();
  const counters = {};
  const count = (k, by = 1) => (counters[k] = (counters[k] ?? 0) + by);
  const intervals = []; // {seat,sid,from,to,eventIndex}
  const hotAttempts = { attempts: 0, won: 0, lost: 0 };
  const hotWon = new Set();
  // Fan-out probe: a dedicated session locks / releases its own private seats; the delta of each
  // lock is timed at every socket of this process (no ambiguity about who locked what).
  const sentAt = new Map(); // probe seat -> wall clock of the lock request
  const io = plan.wsRatio > 0 ? socketIo() : null;
  const sockets = [];
  const t0 = Date.now();
  const deadline = t0 + plan.durationMs;
  const offsets = rampOffsets(slice.count, plan.rampMs, plan.rampProfile);
  let active = 0;
  let peakActive = 0;

  const send = () => {
    let reqs = 0;
    let limited = 0;
    for (const l of stats.labels.values()) {
      reqs += l.n;
      limited += l.statuses[429] ?? 0;
    }
    sampleLoop();
    diag.noteActive(active);
    process.send({ type: 'progress', active, reqs, limited });
  };
  const ticker = setInterval(send, 2000);

  const journeys = Array.from({ length: slice.count }, async (_, k) => {
    const id = slice.start + k;
    await sleep(offsets[k]);
    if (stopping) return;
    const vu = new Vu(cfg, id, stats, diag);
    const rand = rng(plan.seed * 7919 + id);
    active++;
    peakActive = Math.max(peakActive, active);
    diag.noteActive(active);
    try {
      await journey(vu, rand, id);
    } catch (err) {
      count('journey_errors');
      count(`journey_error:${String(err?.message ?? err).slice(0, 60)}`);
    } finally {
      active--;
    }
  });

  async function journey(vu, rand, id) {
    const base = plan.locale ? `/${plan.locale}` : '';
    // primary event of this shopper: deterministic, by the global virtual user id
    const ei = assignEvent(id, events.length, plan.eventWeights);
    const ev = events[ei];
    const { eventId, world } = ev;
    const evStats = perEvent[ei];
    evStats.shoppers++;
    // 1) shop pages (HTML)
    await vu.call('PAGE_HOME', 'GET', `${base}/`);
    if (ev.eventSlug) await vu.call('PAGE_EVENT', 'GET', `${base}/events/${ev.eventSlug}`);
    // 2) enter the shop / waiting room
    if (!(await enter(vu, rand, eventId))) return;
    // 3) seat map + availability like the seating chart page
    await Promise.all([
      vu.call('SEATMAP', 'GET', `/api/events/${eventId}/seatmap`),
      vu.call('AVAILABILITY', 'GET', `/api/events/${eventId}/availability`),
    ]);
    // 4) realtime subscription
    let socket = null;
    if (io && rand() < plan.wsRatio) socket = await openSocket(vu, eventId);
    const held = new Map(); // seat -> interval record (open)
    const lock = async (label, seat, index = ei) => {
      const r = await vu.call(label, 'POST', `/api/events/${events[index].eventId}/seats`, {
        seatIds: [seat],
      });
      if (r.status === 200) {
        held.set(seat, { seat, sid: vu.sid, from: r.wallEnd, to: Infinity, eventIndex: index });
        return true;
      }
      return false;
    };
    // 5) contention on the hot seats
    for (const seat of shuffle(rand, world.hotSeats).slice(0, plan.hotTries)) {
      hotAttempts.attempts++;
      evStats.hotAttempts++;
      if (await lock('LOCK_HOT', seat)) {
        hotAttempts.won++;
        evStats.hotWon++;
        hotWon.add(seat);
        evStats.hotWonSeats.add(seat);
        break;
      }
      hotAttempts.lost++;
      evStats.hotLost++;
      await sleep(50 + rand() * 250);
    }
    // 6) best available for a share of the users (only categories where it can succeed: offered
    // for the category and at least 2 plain seats in best-available blocks)
    const baCategories = world.bestAvailableCategories ?? [];
    if (rand() < plan.bestAvailableRatio && baCategories.length) {
      const cat = pick(rand, baCategories);
      const r = await vu.call('BEST_AVAILABLE', 'POST', `/api/events/${eventId}/best-available`, {
        categoryId: cat.id,
        quantity: Math.min(2 + Math.floor(rand() * 3), cat.seats),
      });
      if (r.status === 200) {
        const seatIds = r.body?.seatIds;
        if (!Array.isArray(seatIds)) {
          // 200 without a usable body: an endpoint failure, not a crash of the journey
          stats.markFailure('BEST_AVAILABLE', 'BAD_BODY');
        } else {
          evStats.bestAvailableOk++;
          for (const seat of seatIds) {
            // the response proves the hold; use the response time as certain start
            held.set(seat, { seat, sid: vu.sid, from: r.wallEnd, to: Infinity, eventIndex: ei });
          }
        }
      }
    }
    // 7) a couple of cold seats, some change their mind
    const wanted = 1 + Math.floor(rand() * 2);
    for (let got = 0, tries = 0; got < wanted && tries < 4 && world.coldSeats.length; tries++) {
      if (await lock('LOCK_RANDOM', pick(rand, world.coldSeats))) {
        got++;
        evStats.coldLocks++;
      }
    }
    await vu.call('CART', 'GET', '/api/cart');
    if (held.size > 1 && rand() < plan.churnRatio) {
      const seat = [...held.keys()][held.size - 1];
      await sleep(100 + rand() * 400);
      const rec = held.get(seat);
      // `to` = the moment the release is SENT: the hold is certain until then.
      rec.to = Date.now();
      const r = await vu.call('UNLOCK', 'DELETE', `/api/events/${eventId}/seats`, {
        seatIds: [seat],
      });
      if (r.status === 200) {
        rec.releaseStatus = r.status;
        intervals.push(rec);
        held.delete(seat);
        count('churn_released');
      } else {
        // Outcome unknown (the server may process it late). The interval closes at the send time,
        // flagged as unknown; the seat stays in the cart and the final cart clear cannot extend it.
        rec.releaseStatus = r.status;
        rec.releaseCode = r.code || null;
        rec.toUnknown = true;
        rec.settled = true;
        intervals.push(rec);
      }
    }
    // 7b) a share of the shoppers also visits a second event and puts 1-2 seats of it into the
    // same cart: the cart (and an order from it) then spans two events
    let multiCart = false;
    if (plan.multiEventRatio > 0 && events.length > 1 && rand() < plan.multiEventRatio) {
      multiCart = await secondEvent(vu, rand, ei, held, lock, socket);
    }
    // 8) optional checkout (dedicated copy only)
    if (plan.checkoutRatio > 0 && held.size > 0 && rand() < plan.checkoutRatio) {
      if (await checkout(vu, id)) {
        evStats.checkoutsOk++;
        if (multiCart) count('checkout_ok_multi');
      }
    }
    // 9) hold the cart for a while (heartbeat reads like a real shopper), then leave
    const holdUntil = Math.min(deadline, Date.now() + plan.holdMs * (0.5 + rand()));
    while (Date.now() < holdUntil && !stopping) {
      await sleep(Math.min(5000, Math.max(0, holdUntil - Date.now())));
      if (Date.now() < holdUntil) await vu.call('CART', 'GET', '/api/cart');
    }
    const open = [...held.values()].filter((rec) => !rec.settled);
    for (const rec of open) rec.to = Date.now(); // release SENT now (certain bound)
    const clear = await vu.call('CART_CLEAR', 'DELETE', '/api/cart');
    for (const rec of open) {
      rec.releaseStatus = clear.status;
      rec.releaseCode = clear.code || null;
      // the server may still have processed it after the client gave up: outcome unknown
      if (clear.status !== 204 && clear.status !== 200) rec.toUnknown = true;
      intervals.push(rec);
    }
    if (socket) socket.close();
  }

  /**
   * Second event of a multi-event shopper: enter it, load its chart like a browser, lock 1-2 of
   * its cold seats. Returns true when the cart now holds seats of both events.
   */
  async function secondEvent(vu, rand, primary, held, lock, socket) {
    let si = Math.floor(rand() * (events.length - 1));
    if (si >= primary) si++;
    const ev = events[si];
    if (!(await enter(vu, rand, ev.eventId))) return false;
    await Promise.all([
      vu.call('SEATMAP', 'GET', `/api/events/${ev.eventId}/seatmap`),
      vu.call('AVAILABILITY', 'GET', `/api/events/${ev.eventId}/availability`),
    ]);
    // a browser on the second chart subscribes to its seat events too (rooms add up)
    if (socket) socket.emit('seats:subscribe', ev.eventId);
    const primaryHeld = [...held.values()].some((rec) => rec.eventIndex === primary);
    const wanted = 1 + Math.floor(rand() * 2);
    let got = 0;
    for (let tries = 0; got < wanted && tries < 4 && ev.world.coldSeats.length; tries++) {
      if (await lock('LOCK_MULTI', pick(rand, ev.world.coldSeats), si)) {
        got++;
        perEvent[si].coldLocks++;
      }
    }
    if (got === 0 || !primaryHeld) return false;
    count('multi_event_carts');
    perEvent[primary].multiEventCarts++;
    return true;
  }

  async function enter(vu, rand, eventId) {
    let r = await vu.call('ENTER', 'POST', `/api/events/${eventId}/enter`);
    const first = classifyEnter(r);
    if (first === 'granted') return true;
    // only a real waiting room status counts as queued; timeouts are counted on their own
    if (first === 'queued') count('queued');
    else if (first === 'timeout' || first === 'network') count('enter_timeout');
    else if (first === 'body_timeout') count('enter_body_timeout');
    // waiting room: poll like the page does (the WebSocket is the fast path in a browser)
    const until = Date.now() + plan.queueMaxWaitMs;
    while (r.status === 200 && Date.now() < until && !stopping) {
      const st = r.body?.status;
      if (st === 'GRANTED') return true;
      if (st === 'ADMITTED') {
        r = await vu.call('CLAIM', 'POST', `/api/events/${eventId}/claim`);
        if (r.body?.status === 'GRANTED') return true;
        continue;
      }
      if (st !== 'QUEUED' && st !== 'LOBBY' && st !== 'NOT_STARTED') break;
      await sleep(2500 + rand() * 1500);
      r = await vu.call('QUEUE', 'GET', `/api/events/${eventId}/queue`);
    }
    count(`enter_failed:${r.status}:${r.body?.status ?? r.code}`);
    return false;
  }

  async function openSocket(vu, eventId) {
    const res = await vu.call('RT_TOKEN', 'GET', '/api/session/realtime-token');
    const token = res.body?.token;
    if (!token) return null;
    const socket = io(cfg.base, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token },
      extraHeaders: cfg.fakeIp ? { 'x-forwarded-for': vu.ip } : {},
      reconnection: false,
    });
    socket.on('seats:delta', (d) => {
      const received = Date.now();
      for (const [seat, status] of d.seats ?? []) {
        if (status !== 'L') continue;
        const t = sentAt.get(seat);
        if (t !== undefined) fanout.record(Math.max(0.1, received - t));
      }
    });
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      socket.on('connect', () => {
        clearTimeout(timer);
        socket.emit('seats:subscribe', eventId);
        resolve(true);
      });
      socket.on('connect_error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!ok) {
      count('ws_failed');
      socket.close();
      return null;
    }
    count('ws_connected');
    sockets.push(socket);
    socket.on('disconnect', () => count('ws_disconnected'));
    return socket;
  }

  async function checkout(vu, id) {
    const cart = (await vu.call('CART', 'GET', '/api/cart')).body;
    if (!cart?.itemCount) return false;
    const r = await vu.call('CHECKOUT', 'POST', '/api/checkout', {
      method: 'BANK_TRANSFER',
      email: `load-${plan.runId}-${id}@example.invalid`,
      firstName: 'Load',
      lastName: `Tester ${id}`,
      phone: '+49 30 1234567',
      address: { street: 'Teststrasse 1', postalCode: '10115', city: 'Berlin', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross: cart.totalGross,
      locale: 'en',
    });
    count(r.status === 200 ? 'checkout_ok' : `checkout_${r.status}`);
    return r.status === 200;
  }

  let probing = true;
  let probeTurn = 0;
  // The probe session is subject to the server's per-session limit for cart mutations
  // (`shop-session`: 120 per minute, not skipped by the load test token). Any two probe requests
  // are at least PROBE_GAP_MS apart (<= ~86 per minute incl. retries); a refused seat (409) moves on
  // to the next probe seat after a pause, a 429 waits for retryAfterMs.
  const PROBE_GAP_MS = 700;
  let probeLastStart = 0;
  const probeWait = async (ms) => {
    // in small steps, so the end of the run is not held back by a long wait
    const until = Date.now() + ms;
    while (Date.now() < until && probing && !stopping) {
      await sleep(Math.min(250, until - Date.now()));
    }
  };
  const probeCall = async (vu, label, method, path, json) => {
    await probeWait(probeLastStart + PROBE_GAP_MS - Date.now());
    probeLastStart = Date.now();
    const r = await vu.call(label, method, path, json);
    if (r.status === 429) {
      count('probe_rate_limited');
      const after = Number(r.body?.error?.details?.retryAfterMs);
      await probeWait(Number.isFinite(after) && after > 0 ? Math.min(after, 60_000) : 5_000);
    }
    return r;
  };
  const probe = (async () => {
    if (!io || !m.probeSeats?.length) return;
    const probeEventId = events[m.probeEventIndex ?? 0].eventId;
    const vu = new Vu(cfg, 4_000_000 + slice.index, stats, diag);
    const rand = rng(plan.seed * 31 + slice.index);
    if (!(await enter(vu, rand, probeEventId))) return;
    await sleep(Math.min(3000, plan.rampMs / 4)); // let the first sockets connect
    while (probing && !stopping) {
      // round robin: a seat is re-used only after several seconds
      const seat = m.probeSeats[probeTurn++ % m.probeSeats.length];
      await probeWait(probeLastStart + PROBE_GAP_MS - Date.now());
      if (!probing || stopping) break;
      const t = Date.now();
      sentAt.set(seat, t);
      // Deltas of this lock count for 4 s only: a later lock of the same seat by someone else
      // (best available) must not be attributed to this probe.
      setTimeout(() => {
        if (sentAt.get(seat) === t) sentAt.delete(seat);
      }, 4000).unref();
      const r = await probeCall(vu, 'PROBE_LOCK', 'POST', `/api/events/${probeEventId}/seats`, {
        seatIds: [seat],
      });
      if (r.status === 200) {
        const rec = {
          seat,
          sid: vu.sid,
          from: r.wallEnd,
          to: Date.now(),
          eventIndex: m.probeEventIndex ?? 0,
        };
        await sleep(700 + rand() * 600);
        rec.to = Date.now();
        const u = await probeCall(
          vu,
          'PROBE_UNLOCK',
          'DELETE',
          `/api/events/${probeEventId}/seats`,
          { seatIds: [seat] },
        );
        rec.releaseStatus = u.status;
        rec.releaseCode = u.code || null;
        if (u.status !== 200) rec.toUnknown = true;
        intervals.push(rec);
      } else {
        sentAt.delete(seat);
        // seat taken (e.g. by best available): the next turn takes the next probe seat
        if (r.status !== 429) await probeWait(1000);
      }
    }
    await vu.call('CART_CLEAR', 'DELETE', '/api/cart');
  })();

  await Promise.all(journeys);
  probing = false;
  await probe;
  clearInterval(ticker);
  for (const s of sockets) s.close();
  sampleLoop();
  loop.disable();
  process.send({
    type: 'done',
    diag: diag.toJSON(),
    loopLag: { peakP99Ms: peakLagP99Ms },
    stats: stats.toJSON(),
    fanout: fanout.toJSON(),
    counters,
    intervals,
    hot: { ...hotAttempts, wonSeats: [...hotWon] },
    perEvent: perEvent.map((e) => ({ ...e, hotWonSeats: [...e.hotWonSeats] })),
    peakActive,
    seconds: (Date.now() - t0) / 1000,
    wsConnectedMax: sockets.length,
    startedAt: t0,
  });
  // give the IPC channel time to flush
  await sleep(100);
  process.exit(0);
}
