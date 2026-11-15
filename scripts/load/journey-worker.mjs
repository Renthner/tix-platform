// Worker process of the journey load test (forked by journey.mjs). Runs a slice of the virtual
// users with realistic journeys and streams its results back over IPC. Not meant to be started
// by hand.
import { Vu, pick, rng, shuffle, sleep, socketIo } from './lib/common.mjs';
import { EndpointStats, Histogram, rampOffsets } from './lib/stats.mjs';

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
  const { cfg, eventId, world, slice, plan } = m;
  const stats = new EndpointStats();
  const fanout = new Histogram();
  const counters = {};
  const count = (k, by = 1) => (counters[k] = (counters[k] ?? 0) + by);
  const intervals = []; // {seat,sid,from,to}
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
    process.send({ type: 'progress', active, reqs, limited });
  };
  const ticker = setInterval(send, 2000);

  const journeys = Array.from({ length: slice.count }, async (_, k) => {
    const id = slice.start + k;
    await sleep(offsets[k]);
    if (stopping) return;
    const vu = new Vu(cfg, id, stats);
    const rand = rng(plan.seed * 7919 + id);
    active++;
    peakActive = Math.max(peakActive, active);
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
    // 1) shop pages (HTML)
    await vu.call('PAGE_HOME', 'GET', `${base}/`);
    if (plan.eventSlug) await vu.call('PAGE_EVENT', 'GET', `${base}/events/${plan.eventSlug}`);
    // 2) enter the shop / waiting room
    if (!(await enter(vu, rand))) return;
    // 3) seat map + availability like the seating chart page
    await Promise.all([
      vu.call('SEATMAP', 'GET', `/api/events/${eventId}/seatmap`),
      vu.call('AVAILABILITY', 'GET', `/api/events/${eventId}/availability`),
    ]);
    // 4) realtime subscription
    let socket = null;
    if (io && rand() < plan.wsRatio) socket = await openSocket(vu);
    const held = new Map(); // seat -> interval record (open)
    const lock = async (label, seat) => {
      const r = await vu.call(label, 'POST', `/api/events/${eventId}/seats`, { seatIds: [seat] });
      if (r.status === 200) {
        held.set(seat, { seat, sid: vu.sid, from: r.wallEnd, to: Infinity });
        return true;
      }
      return false;
    };
    // 5) contention on the hot seats
    for (const seat of shuffle(rand, world.hotSeats).slice(0, plan.hotTries)) {
      hotAttempts.attempts++;
      if (await lock('LOCK_HOT', seat)) {
        hotAttempts.won++;
        hotWon.add(seat);
        break;
      }
      hotAttempts.lost++;
      await sleep(50 + rand() * 250);
    }
    // 6) best available for a share of the users
    if (rand() < plan.bestAvailableRatio && world.categories.length) {
      const cat = pick(rand, world.categories);
      const r = await vu.call('BEST_AVAILABLE', 'POST', `/api/events/${eventId}/best-available`, {
        categoryId: cat.id,
        quantity: 2 + Math.floor(rand() * 3),
      });
      if (r.status === 200) {
        for (const seat of r.body.seatIds ?? []) {
          // the response proves the hold; use the response time as certain start
          held.set(seat, { seat, sid: vu.sid, from: r.wallEnd, to: Infinity });
        }
      }
    }
    // 7) a couple of cold seats, some change their mind
    const wanted = 1 + Math.floor(rand() * 2);
    for (let got = 0, tries = 0; got < wanted && tries < 4 && world.coldSeats.length; tries++) {
      if (await lock('LOCK_RANDOM', pick(rand, world.coldSeats))) got++;
    }
    await vu.call('CART', 'GET', '/api/cart');
    if (held.size > 1 && rand() < plan.churnRatio) {
      const seat = [...held.keys()][held.size - 1];
      await sleep(100 + rand() * 400);
      const rec = held.get(seat);
      rec.to = Date.now();
      const r = await vu.call('UNLOCK', 'DELETE', `/api/events/${eventId}/seats`, {
        seatIds: [seat],
      });
      if (r.status !== 200) rec.to = Infinity;
      else {
        intervals.push(rec);
        held.delete(seat);
        count('churn_released');
      }
    }
    // 8) optional checkout (dedicated copy only)
    if (plan.checkoutRatio > 0 && held.size > 0 && rand() < plan.checkoutRatio) {
      await checkout(vu, id);
    }
    // 9) hold the cart for a while (heartbeat reads like a real shopper), then leave
    const holdUntil = Math.min(deadline, Date.now() + plan.holdMs * (0.5 + rand()));
    while (Date.now() < holdUntil && !stopping) {
      await sleep(Math.min(5000, Math.max(0, holdUntil - Date.now())));
      if (Date.now() < holdUntil) await vu.call('CART', 'GET', '/api/cart');
    }
    for (const rec of held.values()) rec.to = Date.now();
    const clear = await vu.call('CART_CLEAR', 'DELETE', '/api/cart');
    for (const rec of held.values()) {
      if (clear.status !== 204 && clear.status !== 200) rec.to = Infinity; // unknown: stays held
      intervals.push(rec);
    }
    if (socket) socket.close();
  }

  async function enter(vu, rand) {
    let r = await vu.call('ENTER', 'POST', `/api/events/${eventId}/enter`);
    if (r.status === 200 && r.body?.status === 'GRANTED') return true;
    // waiting room: poll like the page does (the WebSocket is the fast path in a browser)
    const until = Date.now() + plan.queueMaxWaitMs;
    count('queued');
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

  async function openSocket(vu) {
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
    if (!cart?.itemCount) return;
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
  }

  let probing = true;
  let probeTurn = 0;
  const probe = (async () => {
    if (!io || !m.probeSeats?.length) return;
    const vu = new Vu(cfg, 4_000_000 + slice.index, stats);
    const rand = rng(plan.seed * 31 + slice.index);
    if (!(await enter(vu, rand))) return;
    await sleep(Math.min(3000, plan.rampMs / 4)); // let the first sockets connect
    while (probing && !stopping) {
      // round robin: a seat is re-used only after several seconds
      const seat = m.probeSeats[probeTurn++ % m.probeSeats.length];
      const t = Date.now();
      sentAt.set(seat, t);
      // Deltas of this lock count for 4 s only: a later lock of the same seat by someone else
      // (best available) must not be attributed to this probe.
      setTimeout(() => {
        if (sentAt.get(seat) === t) sentAt.delete(seat);
      }, 4000).unref();
      const r = await vu.call('PROBE_LOCK', 'POST', `/api/events/${eventId}/seats`, {
        seatIds: [seat],
      });
      if (r.status === 200) {
        const rec = { seat, sid: vu.sid, from: r.wallEnd, to: Date.now() };
        await sleep(700 + rand() * 600);
        rec.to = Date.now();
        const u = await vu.call('PROBE_UNLOCK', 'DELETE', `/api/events/${eventId}/seats`, {
          seatIds: [seat],
        });
        if (u.status !== 200) rec.to = Infinity;
        intervals.push(rec);
      } else {
        sentAt.delete(seat);
        await sleep(300);
      }
    }
    await vu.call('CART_CLEAR', 'DELETE', '/api/cart');
  })();

  await Promise.all(journeys);
  probing = false;
  await probe;
  clearInterval(ticker);
  for (const s of sockets) s.close();
  process.send({
    type: 'done',
    stats: stats.toJSON(),
    fanout: fanout.toJSON(),
    counters,
    intervals,
    hot: { ...hotAttempts, wonSeats: [...hotWon] },
    peakActive,
    seconds: (Date.now() - t0) / 1000,
    wsConnectedMax: sockets.length,
    startedAt: t0,
  });
  // give the IPC channel time to flush
  await sleep(100);
  process.exit(0);
}
