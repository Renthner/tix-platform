// Scenario 4 - waiting room (AUTO_THRESHOLD): many users enter at once. Up to the configured
// threshold they are let in directly, everybody else queues and is admitted in batches. Only
// holders of a valid QueuePassToken may lock seats (also not with another session's token).
import { Metrics, Vu, keyspace, now, pick, rng, sleep } from '../lib/common.mjs';
import { checkSeatLocks } from '../lib/invariants.mjs';
import { Ledger, releaseTogether } from '../lib/rush.mjs';

export const name = 'waiting-room';

export async function run(ctx) {
  const { cfg, world, eventId, report, queueConfig } = ctx;
  const observeMs = Number(ctx.args['queue-seconds'] ?? 150) * 1000;
  const ledger = new Ledger();
  const c = {
    directGrants: 0,
    queued: 0,
    queueFull: 0,
    otherEnter: 0,
    admittedAndClaimed: 0,
    stillWaitingAtEnd: 0,
    unadmittedLockAttempts: 0,
    unadmittedLockAllowed: 0,
    forgedPassAttempts: 0,
    forgedPassAllowed: 0,
    admittedLocks: 0,
  };
  const k = keyspace(cfg.prefix, eventId);

  // No warm-up enter here: the first POST /enter IS the event under test.
  const warm = new Metrics();
  const rush = new Metrics();
  const vus = Array.from({ length: cfg.vus }, (_, i) => new Vu(cfg, i, rush));
  const states = new Array(vus.length).fill('NEW');
  const cursorSamples = [];
  let maxActive = 0;
  const stopAt = { t: 0 };

  const sampler = (async () => {
    let last = -1;
    while (!stopAt.t || now() < stopAt.t + 2000) {
      const state = await ctx.redis.hgetall(k.queueState);
      const cursor = Number(state.cursor ?? 0);
      maxActive = Math.max(maxActive, await ctx.redis.zcard(`${k.ev}:queue:active`));
      if (cursor !== last) {
        cursorSamples.push({ t: Math.round(now()), cursor });
        last = cursor;
      }
      await sleep(250);
    }
  })();

  const lockPath = `/api/events/${eventId}/seats`;
  const durationMs = await releaseTogether(vus, rush, async (vu, i) => {
    const rand = rng(cfg.seed * 31337 + i);
    const enter = await vu.call('ENTER', 'POST', `/api/events/${eventId}/enter`);
    if (enter.status === 503 && enter.code === 'QUEUE_FULL') {
      c.queueFull++;
      return void (states[i] = 'FULL');
    }
    if (enter.status !== 200) return (void c.otherEnter++, (states[i] = 'ERR'));
    if (enter.body.status === 'GRANTED') {
      c.directGrants++;
      states[i] = 'GRANTED';
    } else if (enter.body.status === 'QUEUED') {
      c.queued++;
      states[i] = 'QUEUED';
    } else return (void c.otherEnter++, (states[i] = 'ERR'));

    const seat = () => pick(rand, world.coldSeats);
    if (states[i] === 'GRANTED') {
      const r = await vu.call('LOCK', 'POST', lockPath, { seatIds: [seat()] });
      return void (r.status === 200 && ledger.add(r.body.seatIds[0], vu.id));
    }
    // queued: try to lock WITHOUT a pass (must be refused), then poll until admitted.
    c.unadmittedLockAttempts++;
    const early = await vu.call('LOCK_WITHOUT_PASS', 'POST', lockPath, { seatIds: [seat()] });
    if (early.status === 200) {
      c.unadmittedLockAllowed++;
      ledger.add(early.body.seatIds[0], vu.id);
    }
    const deadline = now() + observeMs;
    while (now() < deadline) {
      await sleep(1500 + rand() * 1500);
      const s = await vu.call('QUEUE_POLL', 'GET', `/api/events/${eventId}/queue`);
      if (s.body?.status === 'ADMITTED' || s.body?.status === 'GRANTED') {
        const claim =
          s.body.status === 'GRANTED'
            ? s
            : await vu.call('CLAIM', 'POST', `/api/events/${eventId}/claim`);
        if (claim.body?.status === 'GRANTED') {
          c.admittedAndClaimed++;
          states[i] = 'ADMITTED';
          const r = await vu.call('LOCK', 'POST', lockPath, { seatIds: [seat()] });
          if (r.status === 200) {
            c.admittedLocks++;
            ledger.add(r.body.seatIds[0], vu.id);
          }
          return;
        }
      }
    }
    c.stillWaitingAtEnd++;
    // still queued at the end: a pass token copied from another session must not work either
    const donor = vus.find((v, j) => j !== i && states[j] === 'GRANTED');
    if (donor && rand() < 0.1) {
      const key = [...donor.jar.keys()].find((n) => n.startsWith('tix_qp_'));
      if (key) {
        c.forgedPassAttempts++;
        vu.jar.set(key, donor.jar.get(key));
        const r = await vu.call('LOCK_FORGED_PASS', 'POST', lockPath, { seatIds: [seat()] });
        if (r.status === 200) {
          c.forgedPassAllowed++;
          ledger.add(r.body.seatIds[0], vu.id);
        }
      }
    }
  });
  stopAt.t = now();
  await sampler;
  ctx.log(`waiting room phase finished in ${Math.round(durationMs)} ms`);

  // ── invariants ──
  report.check(
    `direct admissions <= configured threshold (${queueConfig.threshold})`,
    c.directGrants <= queueConfig.threshold,
    `${c.directGrants} granted directly`,
  );
  report.check(
    'waiting room engaged: users beyond the threshold were queued',
    vus.length <= queueConfig.threshold || c.queued > 0,
    `${c.queued} queued of ${vus.length}`,
  );
  report.check(
    'users without a pass could not lock seats',
    c.unadmittedLockAllowed === 0,
    `${c.unadmittedLockAllowed} of ${c.unadmittedLockAttempts} attempts succeeded`,
  );
  report.check(
    'a pass token of another session is rejected',
    c.forgedPassAllowed === 0,
    `${c.forgedPassAllowed} of ${c.forgedPassAttempts} attempts succeeded`,
  );
  let maxJump = 0;
  for (let i = 1; i < cursorSamples.length; i++)
    maxJump = Math.max(maxJump, cursorSamples[i].cursor - cursorSamples[i - 1].cursor);
  const monotonic = cursorSamples.every(
    (s, i) => i === 0 || s.cursor >= cursorSamples[i - 1].cursor,
  );
  report.check(
    `admission batches never exceed the configured batch size (${queueConfig.batch})`,
    maxJump <= queueConfig.batch && monotonic,
    `largest observed cursor jump ${maxJump}, ${cursorSamples.length} samples`,
  );
  report.check(
    `active shoppers never exceeded the threshold (${queueConfig.threshold})`,
    maxActive <= queueConfig.threshold,
    `maximum sampled active sessions: ${maxActive}`,
  );
  report.check(
    'queued users are admitted over time (positions advance)',
    c.queued === 0 || c.admittedAndClaimed > 0,
    `${c.admittedAndClaimed} admitted + claimed within ${observeMs / 1000}s`,
  );
  const [state, active] = [
    await ctx.redis.hgetall(k.queueState),
    await ctx.redis.zcard(`${k.ev}:queue:active`),
  ];
  await checkSeatLocks({
    report,
    redis: ctx.redis,
    cfg,
    eventId,
    ledger: ledger.map,
    sidOf: (i) => vus[i].sid,
    gaGranted: null,
  });
  await Promise.all(vus.map((vu) => vu.call('CART_CLEAR', 'DELETE', '/api/cart')));
  return {
    warmup: warm.summary(1),
    rush: rush.summary(durationMs),
    details: { ...c, queueState: state, activeSessions: active, maxActive, cursorSamples },
  };
}
