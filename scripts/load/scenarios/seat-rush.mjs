// Scenario 1 - seat rush: all virtual users start at the same instant and fight for a few "hot"
// seats plus random seats and the standing area; some release a seat and re-try (churn).
import { now, pick, rng, shuffle, sleep } from '../lib/common.mjs';
import { checkSeatLocks } from '../lib/invariants.mjs';
import {
  Ledger,
  observerConvergence,
  prepareVus,
  releaseSeats,
  releaseTogether,
  startObservers,
} from '../lib/rush.mjs';

export const name = 'seat-rush';

export async function run(ctx) {
  const { cfg, world, eventId, report } = ctx;
  const ledger = new Ledger();
  const hot = { attempts: 0, won: 0, lost: 0 };
  let gaGranted = 0;
  const counters = { churnReleased: 0, vusWithHot: 0, vusWithoutAnySeat: 0 };

  const obs = await startObservers(ctx, cfg.observers);
  const { vus, warm, rush } = await prepareVus(ctx);
  const lockPath = `/api/events/${eventId}/seats`;

  const tryLock = async (vu, label, seat) => {
    const r = await vu.call(label, 'POST', lockPath, { seatIds: [seat] });
    if (r.status === 200) ledger.add(seat, vu.id);
    return r;
  };

  const durationMs = await releaseTogether(vus, rush, async (vu, i) => {
    const rand = rng(cfg.seed * 7919 + i);
    let seatsHeld = 0;
    // 1) one of the hot seats (retry with other hot seats when it is taken)
    const hotOrder = shuffle(rand, world.hotSeats);
    let wonHot = false;
    for (const seat of hotOrder.slice(0, 3)) {
      hot.attempts++;
      const r = await tryLock(vu, 'LOCK_HOT', seat);
      if (r.status === 200) {
        hot.won++;
        wonHot = true;
        seatsHeld++;
        break;
      }
      hot.lost++;
    }
    if (wonHot) counters.vusWithHot++;
    // 2) one or two random seats of the rest of the house
    const wanted = rand() < 0.5 ? 1 : 2;
    const mine = [];
    for (let got = 0, tries = 0; got < wanted && tries < 4; tries++) {
      const seat = pick(rand, world.coldSeats);
      if (mine.includes(seat)) continue;
      const r = await tryLock(vu, 'LOCK_RANDOM', seat);
      if (r.status === 200) {
        got++;
        mine.push(seat);
        seatsHeld++;
      }
    }
    // 3) a standing spot
    if (world.ga) {
      const r = await vu.call('GA_HOLD', 'PUT', `/api/events/${eventId}/general-admission`, {
        sectionId: world.ga.id,
        quantity: 1,
      });
      if (r.status === 200) {
        gaGranted++;
        seatsHeld++;
      }
    }
    // 4) read traffic like a browser would produce
    await Promise.all([
      vu.call('AVAILABILITY', 'GET', `/api/events/${eventId}/availability`),
      vu.call('CART', 'GET', '/api/cart'),
    ]);
    // 5) churn: some users give a random seat back and try another one
    if (mine.length && rand() < 0.15) {
      await sleep(100 + rand() * 500);
      if (await releaseSeats(ctx, vu, ledger, [mine[0]])) {
        counters.churnReleased++;
        await tryLock(vu, 'LOCK_RANDOM', pick(rand, world.coldSeats));
      }
    }
    if (seatsHeld === 0) counters.vusWithoutAnySeat++;
  });

  ctx.log(`rush finished in ${Math.round(durationMs)} ms`);
  // ── invariants (before any cleanup) ──
  const conv = await observerConvergence(ctx, obs.observers);
  await checkSeatLocks({
    report,
    redis: ctx.redis,
    cfg,
    eventId,
    ledger: ledger.map,
    sidOf: (i) => vus[i].sid,
    gaGranted: world.ga ? gaGranted : null,
  });
  const hotWinners = world.hotSeats.filter((s) => (ledger.map.get(s) ?? []).length === 1);
  report.check(
    `every hot seat has exactly one winner (${world.hotSeats.length} seats, ${vus.length} contenders)`,
    hotWinners.length === Math.min(world.hotSeats.length, vus.length) &&
      hot.won === hotWinners.length,
    `${hotWinners.length} seats won, ${hot.won} successful hot requests, ${hot.lost} lost`,
  );
  if (world.ga) {
    report.check(
      'standing area granted exactly its capacity (oversubscribed)',
      gaGranted === Math.min(world.ga.available, vus.length),
      `granted ${gaGranted} of ${world.ga.available}`,
    );
  }
  if (obs.connected > 0) {
    report.check(
      `realtime: ${obs.connected} observers converge to the Redis state after the rush`,
      conv.converged,
      `${conv.mismatching} diverging after ${conv.ms} ms; connect failures ${obs.failed}`,
    );
  } else report.skip('realtime observers', 'disabled (--observers 0)');

  // ── cleanup: release everything again (also exercises DELETE /api/cart) ──
  const t0 = now();
  await Promise.all(vus.map((vu) => vu.call('CART_CLEAR', 'DELETE', '/api/cart')));
  ctx.log(`cart clear for all users took ${Math.round(now() - t0)} ms`);
  obs.close();
  return {
    warmup: warm.summary(1),
    rush: rush.summary(durationMs),
    details: {
      ...counters,
      hot,
      gaGranted,
      ledgerSeats: ledger.map.size,
      observers: obs.connected,
      realtime: conv,
    },
  };
}
