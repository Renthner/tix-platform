// Scenario 2 - best-available rush: every user asks for 2-4 adjacent seats of a category at the
// same moment; the backend picks and locks them atomically. No seat may be handed out twice.
import { pick, rng, sleep } from '../lib/common.mjs';
import { checkSeatLocks } from '../lib/invariants.mjs';
import {
  Ledger,
  observerConvergence,
  prepareVus,
  releaseSeats,
  releaseTogether,
  startObservers,
} from '../lib/rush.mjs';

export const name = 'best-available';

export async function run(ctx) {
  const { cfg, world, eventId, report } = ctx;
  const ledger = new Ledger();
  const rowOf = new Map(world.map.seats.map((s) => [s.i, s.r]));
  const counters = {
    granted: 0,
    soldOut: 0,
    otherRefusals: 0,
    seatsGranted: 0,
    sameRow: 0,
    churnReleased: 0,
  };
  const sizes = {};
  const obs = await startObservers(ctx, cfg.observers);
  const { vus, warm, rush } = await prepareVus(ctx);
  const seatCats = world.categories.filter((c) => world.map.seats.some((s) => s.c === c.id));

  const durationMs = await releaseTogether(vus, rush, async (vu, i) => {
    const rand = rng(cfg.seed * 104729 + i);
    const quantity = 2 + Math.floor(rand() * 3);
    const category = pick(rand, seatCats);
    const r = await vu.call('BEST_AVAILABLE', 'POST', `/api/events/${eventId}/best-available`, {
      categoryId: category.id,
      quantity,
    });
    if (r.status === 200 && Array.isArray(r.body?.seatIds)) {
      counters.granted++;
      counters.seatsGranted += r.body.seatIds.length;
      sizes[r.body.seatIds.length] = (sizes[r.body.seatIds.length] ?? 0) + 1;
      if (new Set(r.body.seatIds.map((s) => rowOf.get(s))).size === 1) counters.sameRow++;
      for (const s of r.body.seatIds) ledger.add(s, vu.id);
      await Promise.all([
        vu.call('AVAILABILITY', 'GET', `/api/events/${eventId}/availability`),
        vu.call('CART', 'GET', '/api/cart'),
      ]);
      // churn: a few users give their seats back (the next request may take them)
      if (rand() < 0.1) {
        await sleep(100 + rand() * 400);
        if (await releaseSeats(ctx, vu, ledger, r.body.seatIds)) counters.churnReleased++;
      }
    } else if (r.status === 409 || r.status === 422) {
      counters.soldOut++;
    } else counters.otherRefusals++;
  });
  ctx.log(`rush finished in ${Math.round(durationMs)} ms`);

  const conv = await observerConvergence(ctx, obs.observers);
  await checkSeatLocks({
    report,
    redis: ctx.redis,
    cfg,
    eventId,
    ledger: ledger.map,
    sidOf: (i) => vus[i].sid,
    gaGranted: null,
  });
  report.check(
    'best-available answers are only "granted" or a business refusal (no 5xx / timeouts)',
    counters.otherRefusals === 0,
    `${counters.otherRefusals} unexpected responses`,
  );
  if (obs.connected > 0) {
    report.check(
      `realtime: ${obs.connected} observers converge to the Redis state after the rush`,
      conv.converged,
      `${conv.mismatching} diverging after ${conv.ms} ms`,
    );
  }
  await Promise.all(vus.map((vu) => vu.call('CART_CLEAR', 'DELETE', '/api/cart')));
  obs.close();
  return {
    warmup: warm.summary(1),
    rush: rush.summary(durationMs),
    details: { ...counters, groupSizes: sizes, ledgerSeats: ledger.map.size, realtime: conv },
  };
}
