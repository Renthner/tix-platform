// Realistic journey load test for a running server (production-like or a dedicated copy).
//
//   node scripts/load/journey.mjs --target https://shop.example.org --event-id <uuid> \
//        --yes --vus 1000 --ramp 60s --duration 4m          (token via TIX_LOADTEST_TOKEN)
//   node scripts/load/journey.mjs --target ... --event-id <uuid> --dry-run
//
// Simulates N shoppers (multiple worker processes): shop pages, waiting room, seat map,
// WebSocket subscription (fan-out latency), contention on the SAME hot seats, best available,
// cart churn and cleanup, optional checkout. Verifies hot-seat exclusivity from the hold intervals
// of all sessions, optionally double bookings in the database, and scrapes /api/metrics and
// /__tix/health before / during / after. See docs/LOAD-TEST.md. Exit code 0 = all assertions held,
// 1 = an assertion failed, 2 = refused / failed to run.
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Vu, applyIpv4Only, buildConfig, openDb, parseArgs, sleep } from './lib/common.mjs';
import { CpuSampler, Diagnostics, diagnoseDiagnostics, summarizeLoopLag } from './lib/diag.mjs';
import {
  EndpointStats,
  Histogram,
  checkDatabaseTarget,
  checkTarget,
  diagnosisHints,
  evaluateAssertions,
  findOverlaps,
  foldMetricSample,
  looksLikeToken,
  parseDuration,
  parsePrometheus,
  redact,
  sliceUsers,
} from './lib/stats.mjs';
import {
  leakReport,
  mergeEventStats,
  parseEventList,
  parseEventWeights,
  parseMultiEventRatio,
  perEventHotCheck,
} from './lib/events.mjs';
import { loadWorld } from './lib/world.mjs';

const args = parseArgs(process.argv.slice(2));
const worker = fileURLToPath(new URL('./journey-worker.mjs', import.meta.url));
const resultsDir = new URL('./results/', import.meta.url);

const HELP = `Journey load test (see docs/LOAD-TEST.md)

  --target <url>            server under test (required; never the regular stack on :8080/:3000)
  --event-id <uuid>[,...]   event(s) to shop on (required; PUBLISHED, ideally unlisted test events;
                            up to 20 comma-separated ids load several events at once)
  --event-slug <slug>[,...] also fetch the public event page (optional; one slug per event id)
  --event-weights <w,...>   share of the shoppers per event, e.g. 3,1,1 (default: even split)
  --multi-event-ratio <r>   share (0..1) of shoppers who also lock seats on a second event, so
                            their cart / order spans two events (default 0.1 with several events)
  --loadtest-token <t>      token of Admin -> System -> Load test mode (or env TIX_LOADTEST_TOKEN)
  --yes                     confirm that you are allowed to load this server
  --dry-run                 print the plan, change and send nothing
  --vus <n>                 virtual users (default 1000)
  --workers <n>             generator processes (default min(cpus, ceil(vus/250)), max 8)
  --ramp <dur>              ramp-up time (default 60s)   --ramp-profile linear|step|spike
  --duration <dur>          total run time incl. ramp (default 4m)
  --hold <dur>              average time a shopper keeps the cart (default 60s, max 8m)
  --hot <n>                 number of hot seats everybody fights for (default 20)
  --best-available <0..1>   share using best available (default 0.3)
  --ws-ratio <0..1>         share of users with a WebSocket (default 1)
  --checkout-ratio <0..1>   share placing a bank-transfer order (default 0; creates REAL orders and
                            e-mails - dedicated copy with an SMTP sink only; needs --allow-orders)
  --metrics-token <t>       token of /api/metrics (or env TIX_METRICS_TOKEN)
  --database-url <url>      optional read-only double-booking check against the database
                            (read-only session; private / LAN hosts are refused unless --allow-private)
  --allow-private           allow a private / LAN database host for --database-url
  --locale <de|en>          locale prefix of the pages (default: none = the shop's default locale)
  --ipv4-only               resolve IPv4 first and do not race address families: rules out a
                            public AAAA / Cloudflare path when you test via a hosts-file entry
  --out <file>              result JSON (default scripts/load/results/journey.json)
  --max-failure-rate / --max-429-rate / --max-503-rate / --max-fanout-p95-ms   assertion limits
`;

function refuse(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

if (args.help || args.h) {
  console.log(HELP);
  process.exit(0);
}

// ── safety ────────────────────────────────────────────────────────────────────────
const targetCheck = checkTarget(args.target);
if (!targetCheck.ok) refuse(targetCheck.reason);
if (args['database-url']) {
  const dbCheck = checkDatabaseTarget(args['database-url'], {
    allowPrivate: Boolean(args['allow-private']),
  });
  if (!dbCheck.ok) refuse(dbCheck.reason);
}
const eventList = parseEventList(args['event-id'], args['event-slug']);
if (!eventList.ok) refuse(eventList.reason);
const events = eventList.events;
const eventId = events[0].eventId;
const weightsArg = parseEventWeights(args['event-weights'], events.length);
if (!weightsArg.ok) refuse(weightsArg.reason);
const multiArg = parseMultiEventRatio(args['multi-event-ratio'], events.length);
if (!multiArg.ok) refuse(multiArg.reason);
const multi = events.length > 1;
const dryRun = Boolean(args['dry-run']);
const token = dryRun
  ? null
  : String(args['loadtest-token'] ?? process.env.TIX_LOADTEST_TOKEN ?? '') || null;
if (!dryRun) {
  if (!args.yes) {
    refuse(
      `this sends heavy load to ${targetCheck.url.origin}. Re-run with --yes once you own the target or have permission, or use --dry-run.`,
    );
  }
  if (!token || !looksLikeToken(token)) {
    refuse(
      'the load test token is required (Admin -> System -> Load test mode; pass --loadtest-token or env TIX_LOADTEST_TOKEN). Without it the per-IP limits would distort the test.',
    );
  }
}
const checkoutRatio = Number(args['checkout-ratio'] ?? 0);
if (checkoutRatio > 0 && !args['allow-orders']) {
  refuse(
    '--checkout-ratio creates real orders and e-mails: add --allow-orders (dedicated copy only)',
  );
}

const vus = Math.max(1, Math.floor(Number(args.vus ?? 1000)));
const workers = Math.max(
  1,
  Math.min(8, Math.floor(Number(args.workers ?? Math.min(os.cpus().length, Math.ceil(vus / 250))))),
);
const durationMs = parseDuration(args.duration, 240_000);
const rampMs = Math.min(parseDuration(args.ramp, 60_000), durationMs);
const holdMs = Math.min(parseDuration(args.hold, 60_000), 8 * 60_000);
const plan = {
  runId: Math.random().toString(36).slice(2, 10),
  seed: Number(args.seed ?? 42),
  locale: args.locale ? String(args.locale) : '',
  eventSlug: events[0].eventSlug,
  eventCount: events.length,
  eventWeights: weightsArg.weights,
  multiEventRatio: multiArg.ratio,
  durationMs,
  rampMs,
  rampProfile: String(args['ramp-profile'] ?? 'linear'),
  holdMs,
  hotTries: 3,
  bestAvailableRatio: Number(args['best-available'] ?? 0.3),
  churnRatio: 0.15,
  wsRatio: Math.min(1, Math.max(0, Number(args['ws-ratio'] ?? 1))),
  checkoutRatio,
  queueMaxWaitMs: Math.min(durationMs, 5 * 60_000),
};
const limits = {
  maxFailureRate: Number(args['max-failure-rate'] ?? 0.01),
  max429Rate: Number(args['max-429-rate'] ?? 0.001),
  max503Rate: Number(args['max-503-rate'] ?? 0.02),
  maxFanoutP95Ms: Number(args['max-fanout-p95-ms'] ?? 2000),
};
const cfg = {
  ...buildConfig({
    ...args,
    target: targetCheck.url.origin,
    vus: String(vus),
    hot: args.hot ?? 20,
  }),
  loadtestToken: token,
  fakeIp: false, // never spoof client addresses against a real target: the token is the sanctioned way
};

applyIpv4Only(cfg);

console.log(`Journey load test
  target        ${targetCheck.url.origin}
${
  multi
    ? `  events        ${events.length}, shoppers ${weightsArg.weights ? `weighted ${weightsArg.weights.join(':')}` : 'split evenly'}, multi-event ratio ${plan.multiEventRatio}
${events.map((e, i) => `    [${i + 1}] ${e.eventId}${e.eventSlug ? ` (${e.eventSlug})` : ''}${weightsArg.weights ? `  weight ${weightsArg.weights[i]}` : ''}`).join('\n')}`
    : `  event         ${eventId}${plan.eventSlug ? ` (${plan.eventSlug})` : ''}`
}
  virtual users ${vus} in ${workers} process(es), ramp ${plan.rampProfile} ${rampMs / 1000}s, run ${durationMs / 1000}s, hold ~${holdMs / 1000}s
  hot seats     ${cfg.hot}, best-available ${plan.bestAvailableRatio}, websocket ${plan.wsRatio}, checkout ${checkoutRatio}
  network       ${cfg.ipv4Only ? 'IPv4 only (--ipv4-only)' : 'default address selection (use --ipv4-only to exclude AAAA / Cloudflare paths)'}
  token         ${token ? 'provided (sent as X-Tix-Loadtest header)' : 'not provided'}
  limits        ${JSON.stringify(limits)}`);
if (dryRun) {
  console.log('\nDRY RUN: nothing was sent. Steps of a real run:');
  console.log(
    ' 1. GET /__tix/health and /api/health, scrape /api/metrics (if a metrics token is given)\n' +
      ' 2. load the seat map and pick hot seats\n' +
      ' 3. ramp up the shoppers (pages, enter / waiting room, seat map, WebSocket, hot-seat fights,\n' +
      '    best available, cart churn, cart cleanup)\n' +
      ' 4. verify hot-seat exclusivity from the hold intervals, check leaked locks, optional DB check\n' +
      ' 5. write the JSON result + summary',
  );
  if (multi) {
    console.log(
      `With ${events.length} events: steps 2 and 4 run per event (hot seats, leak check, hot-seat\n` +
        'contention per event); every shopper shops on one primary event, a share of them also locks\n' +
        'seats on a second event (multi-event cart / order).',
    );
  }
  process.exit(0);
}

// ── probes ────────────────────────────────────────────────────────────────────────
const metricsToken = args['metrics-token'] ?? process.env.TIX_METRICS_TOKEN ?? null;
async function getJson(path, headers = {}) {
  try {
    const res = await fetch(cfg.base + path, {
      headers,
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: 0, text: '', error: redact(err?.message ?? err, token) };
  }
}
async function snapshot() {
  const health = await getJson('/__tix/health');
  const out = { at: new Date().toISOString(), health: null, metrics: null };
  try {
    out.health = health.status ? { status: health.status, body: JSON.parse(health.text) } : null;
  } catch {
    out.health = { status: health.status };
  }
  if (metricsToken) {
    const m = await getJson('/api/metrics', { authorization: `Bearer ${metricsToken}` });
    out.metrics = m.status === 200 ? parsePrometheus(m.text) : { error: `HTTP ${m.status}` };
  }
  return out;
}

let aborted = false;
const children = [];
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (aborted) process.exit(2);
    aborted = true;
    console.log(`\n${sig}: stopping shoppers and cleaning up carts (press again to force quit)`);
    for (const c of children) c.send({ type: 'stop' });
  });
}

let generatorCpu = null;

async function main() {
  const before = await snapshot();
  if (!before.health || before.health.status !== 200) {
    console.log(
      `warning: /__tix/health did not answer 200 (${before.health?.status ?? 'unreachable'}); continuing`,
    );
  }
  const probeStats = new EndpointStats();
  const probe = new Vu(cfg, 3_000_000, probeStats);
  const setups = [];
  for (const ev of events) {
    const enter = await probe.call('SETUP_ENTER', 'POST', `/api/events/${ev.eventId}/enter`);
    if (enter.status !== 200) {
      throw new Error(
        `cannot enter the event shop${multi ? ` of event ${ev.eventId}` : ''} (HTTP ${enter.status} ${enter.code}). Is the event published and the id right?`,
      );
    }
    const world = await loadWorld(cfg, probe, ev.eventId);
    if (world.hotSeats.length === 0) {
      throw new Error(`no usable seats on the event${multi ? ` ${ev.eventId}` : ''}`);
    }
    const lockedBefore = new Set(
      (await probe.call('SETUP_AVAILABILITY', 'GET', `/api/events/${ev.eventId}/availability`)).body
        ?.locked ?? [],
    );
    console.log(
      `event${multi ? ` ${ev.eventId}` : ''}: ${world.usable.length} plain seats (${world.hotSeats.length} hot), standing ${world.ga?.available ?? 0}, ${lockedBefore.size} seats held by others before the run`,
    );
    setups.push({ ...ev, world, lockedBefore });
  }

  // ── resource sampling ──
  // Every 5 s a few quick parallel scrapes: with several web processes consecutive requests hit
  // different ones (the per-process metrics carry a pid label), the PEAK per metric and pid is kept.
  const peaks = {};
  const scrapes = { ok: 0, failed: 0 };
  let sampling = true;
  const SCRAPES_PER_TICK = 4;
  const sampler = (async () => {
    while (sampling) {
      await sleep(5_000);
      if (!sampling || !metricsToken) continue;
      const tick = await Promise.all(
        Array.from({ length: SCRAPES_PER_TICK }, () =>
          getJson('/api/metrics', { authorization: `Bearer ${metricsToken}` }),
        ),
      );
      for (const m of tick) {
        if (m.status !== 200) {
          scrapes.failed++;
          continue;
        }
        scrapes.ok++;
        foldMetricSample(peaks, parsePrometheus(m.text));
      }
    }
  })();

  // ── workers ──
  const slices = sliceUsers(vus, workers);
  const t0 = Date.now();
  const results = [];
  const cpu = new CpuSampler(2000);
  cpu.start();
  const progress = new Map();
  // Private seats of the fan-out probes (4 per process), not used by the shoppers' random picks.
  // Worker w probes event w % n; seat ids are UUIDs, unique across events, so a delta is attributed
  // by the seat id (sentAt) alone.
  const probeSeats = slices.map((_, w) => setups[w % setups.length].world.coldSeats.splice(-4));
  if (slices.length < setups.length) {
    console.log(
      `note: ${slices.length} generator process(es) for ${setups.length} events - the fan-out probe measures only the first ${slices.length} event(s) (raise --workers to probe all)`,
    );
  }
  const slim = setups.map((s) => ({
    eventId: s.eventId,
    eventSlug: s.eventSlug,
    world: {
      hotSeats: s.world.hotSeats,
      coldSeats: s.world.coldSeats,
      categories: s.world.categories,
      bestAvailableCategories: s.world.bestAvailableCategories,
    },
  }));
  let abortReason = null;
  const finished = new Set();
  const runs = slices.map(
    (slice, w) =>
      new Promise((resolve, reject) => {
        const child = fork(worker, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
        children.push(child);
        child.on('message', (msg) => {
          if (msg.type === 'progress') progress.set(w, msg);
          else if (msg.type === 'done') {
            finished.add(w);
            results.push(msg);
            resolve();
          } else if (msg.type === 'error') reject(new Error(redact(msg.message, token)));
        });
        child.on('exit', (code) => {
          if (code !== 0 && !finished.has(w)) reject(new Error(`worker ${w} exit ${code}`));
        });
        child.send({
          type: 'start',
          cfg,
          events: slim,
          slice: { ...slice, index: w },
          plan: { ...plan, wsRatio: plan.wsRatio },
          probeEventIndex: w % slim.length,
          probeSeats: probeSeats[w],
          runStart: t0,
        });
      }),
  );
  const status = setInterval(() => {
    let active = 0;
    let reqs = 0;
    let limited = 0;
    for (const p of progress.values()) {
      active += p.active ?? 0;
      reqs += p.reqs ?? 0;
      limited += p.limited ?? 0;
    }
    // A flood of 429s means the token is not accepted / the mode is off / a WAF limits us:
    // continuing would only measure the limiter, so stop (carts are cleaned up).
    if (!abortReason && reqs > 500 && limited / reqs > 0.2) {
      abortReason = `${Math.round((limited / reqs) * 100)} % of the requests were rate limited (429): load test mode not active, wrong token, or a proxy / WAF in front limits this generator`;
      console.log(`
ABORT: ${abortReason}`);
      for (const c of children) c.send({ type: 'stop' });
    }
    process.stdout.write(
      `\r[${Math.round((Date.now() - t0) / 1000)}s] active shoppers ${active}   `,
    );
  }, 2000);
  try {
    await Promise.all(runs);
  } finally {
    clearInterval(status);
    sampling = false;
    generatorCpu = cpu.stop();
    await sampler;
    for (const c of children) if (c.exitCode === null) c.kill();
  }
  process.stdout.write('\n');

  // ── aggregate ──
  const total = new EndpointStats().merge(probeStats);
  const fanout = new Histogram();
  const counters = {};
  const intervals = [];
  const hot = { attempts: 0, won: 0, lost: 0 };
  const hotWonSeats = new Set();
  let ws = 0;
  for (const r of results) {
    total.merge(EndpointStats.fromJSON(r.stats));
    fanout.merge(Histogram.fromJSON(r.fanout));
    for (const [k, v] of Object.entries(r.counters)) counters[k] = (counters[k] ?? 0) + v;
    for (const iv of r.intervals) intervals.push(iv);
    hot.attempts += r.hot.attempts;
    hot.won += r.hot.won;
    hot.lost += r.hot.lost;
    for (const s of r.hot.wonSeats) hotWonSeats.add(s);
    ws += r.wsConnectedMax;
  }
  const perEvent = mergeEventStats(
    setups.length,
    results.map((r) => r.perEvent),
  );
  const diag = new Diagnostics(t0);
  for (const r of results) if (r.diag) diag.merge(Diagnostics.fromJSON(r.diag));
  const generator = {
    cpu: generatorCpu,
    loopLag: summarizeLoopLag(results.map((r) => r.loopLag)),
  };
  const seconds = (Date.now() - t0) / 1000;
  const summary = total.summary(seconds);
  const { certain: overlaps, indeterminate } = findOverlaps(intervals);

  // ── post-run checks ──
  await sleep(1500);
  const after = await snapshot();
  for (const s of setups) {
    const availAfter = (await getJson(`/api/events/${s.eventId}/availability`)).text;
    s.lockedAfter = new Set();
    try {
      s.lockedAfter = new Set(JSON.parse(availAfter).locked ?? []);
    } catch {
      /* reported below */
    }
  }
  const leaks = leakReport(setups);
  const hotSeatTotal = setups.reduce((a, s) => a + s.world.hotSeats.length, 0);
  const ledger = {
    intervals: intervals.length,
    hotSeats: hotSeatTotal,
    hotWon: hot.won,
    hotLost: hot.lost,
    hotContenders: vus,
  };
  const rt = {
    connected: ws,
    samples: fanout.n,
    p50: round(fanout.percentile(50)),
    p95: round(fanout.percentile(95)),
    p99: round(fanout.percentile(99)),
    max: round(fanout.max),
  };
  const checks = evaluateAssertions({
    summary,
    overlaps,
    indeterminateOverlaps: indeterminate,
    limits,
    ledger,
    rt,
  });
  const eventsOut = setups.map((s, i) => {
    const e = perEvent[i];
    return {
      eventId: s.eventId,
      eventSlug: s.eventSlug,
      shoppers: e.shoppers,
      hot: {
        attempts: e.hotAttempts,
        won: e.hotWon,
        lost: e.hotLost,
        seatsWon: e.hotWonSeats.size,
        of: s.world.hotSeats.length,
      },
      coldLocks: e.coldLocks,
      bestAvailableOk: e.bestAvailableOk,
      checkoutsOk: e.checkoutsOk,
      multiEventCarts: e.multiEventCarts,
      lockedBefore: s.lockedBefore.size,
      leakedLocks: leaks.perEvent[i].leaked,
    };
  });
  if (multi) {
    // the summed ledger alone could hide an event whose hot seats were never fought for
    checks.push(
      perEventHotCheck(
        eventsOut.map((e) => ({
          eventId: e.eventId,
          shoppers: e.shoppers,
          hotSeats: e.hot.of,
          hotWon: e.hot.won,
          hotLost: e.hot.lost,
        })),
      ),
    );
  }
  checks.push({
    title: 'no seat lock leaked after every shopper emptied the cart',
    ok: leaks.total === 0,
    detail: leaks.detail,
  });
  if (args['database-url']) {
    try {
      const db = await openDb(String(args['database-url']), { readOnly: true });
      const { rows } = await db.query(
        `SELECT seat_id, count(*)::int AS n FROM order_items
          WHERE seat_id IS NOT NULL AND status IN ('PENDING','CONFIRMED')
          GROUP BY seat_id HAVING count(*) > 1`,
      );
      await db.end();
      checks.push({
        title: 'database: no seat in two active order items (double booking)',
        ok: rows.length === 0,
        detail: `${rows.length} seats`,
      });
    } catch (err) {
      checks.push({
        title: 'database check',
        ok: false,
        detail: redact(`could not run: ${err?.message ?? err}`, token),
      });
    }
  }
  if (abortReason) checks.push({ title: 'run was not aborted', ok: false, detail: abortReason });
  const passed = checks.every((c) => c.ok);
  const out = {
    tool: 'journey',
    startedAt: new Date(t0).toISOString(),
    target: cfg.base,
    eventId,
    eventIds: setups.map((s) => s.eventId),
    plan: { ...plan, vus, workers, limits, timeoutMs: cfg.timeoutMs },
    seconds: Math.round(seconds * 10) / 10,
    summary,
    hotSeats: { ...hot, seatsWon: hotWonSeats.size, of: hotSeatTotal },
    events: eventsOut,
    realtime: rt,
    counters,
    overlaps: overlaps.length,
    overlapDetails: overlaps.slice(0, 20).map((o) => o.details),
    indeterminateOverlaps: indeterminate.length,
    indeterminateOverlapDetails: indeterminate.slice(0, 20).map((o) => o.details),
    leakedLocks: leaks.total,
    resources: { before, after, peaksDuringRun: peaks, metricScrapes: scrapes },
    errorSamples: diag.errorSamples(),
    networkErrorCauses: diag.networkErrorCauses(),
    pathIndicator: diag.pathIndicator({ ipv4Only: cfg.ipv4Only }),
    timeline: diag.timeline(),
    generator,
    diagnosis: [
      ...diagnosisHints({ summary, peaks, scrapes }),
      ...diagnoseDiagnostics({ diag, generator }),
    ],
    checks,
    passed,
    aborted: aborted || Boolean(abortReason),
    abortReason,
  };
  mkdirSync(resultsDir, { recursive: true });
  const outFile = args.out ? String(args.out) : fileURLToPath(new URL('journey.json', resultsDir));
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  print(out, outFile);
  process.exit(passed ? 0 : 1);
}

const round = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

function print(o, file) {
  const line = (s = '') => console.log(s);
  line(`\n=== journey: ${o.plan.vus} virtual users, ${o.seconds} s ===`);
  line(
    `requests ${o.summary.requests} (${o.summary.requestsPerSecond}/s)  5xx+network ${o.summary.failures5xxOrNetwork}  429 ${o.summary.rateLimited429}  503 ${o.summary.unavailable503}  timeouts ${o.summary.timeouts}`,
  );
  const mb = (n) => (n / 1048576).toFixed(1);
  line(
    `received ${mb(o.summary.bytesReceived)} MB in total (${mb(o.summary.bytesPerSecond ?? 0)} MB/s = ${(((o.summary.bytesPerSecond ?? 0) * 8) / 1e6).toFixed(1)} Mbit/s; decoded bodies, no WebSocket traffic): compare with the uplink`,
  );
  if (o.summary.timeouts > 0)
    line(`timeouts by endpoint: ${JSON.stringify(o.summary.timeoutsByEndpoint)}`);
  line('endpoint                 reqs     p50     p95     p99     max   statuses');
  for (const [label, e] of Object.entries(o.summary.endpoints)) {
    line(
      `${label.padEnd(22)} ${String(e.requests).padStart(6)} ${String(e.p50).padStart(7)} ${String(e.p95).padStart(7)} ${String(e.p99).padStart(7)} ${String(e.max).padStart(7)}   ${JSON.stringify(e.statuses)}`,
    );
  }
  const pi = o.pathIndicator;
  line(
    `\nresponses via Cloudflare: ${pi.cloudflare} of ${pi.responses} (cf-ray ${pi.cfRay}, server: cloudflare ${pi.serverCloudflare}); ipv4-only ${pi.ipv4Only ? 'yes' : 'no'}`,
  );
  if (pi.remoteAddresses.length)
    line(
      `remote addresses used (${pi.distinctRemoteAddresses} distinct, top 5 by connections): ${pi.remoteAddresses.map((a) => `${a.address} x${a.connections}`).join(', ')}`,
    );
  if (pi.cloudflare > 0 && !pi.ipv4Only)
    line(
      `WARNING: ${pi.cloudflare} responses came via Cloudflare although a LAN path was intended; re-run with --ipv4-only to rule out an IPv6 / AAAA path`,
    );
  const nc = o.networkErrorCauses;
  if (nc.harnessTimeouts + nc.connectionErrors > 0) {
    line(
      `\nnetwork errors (status 0): ${nc.harnessTimeouts} harness-side aborts (our ${o.plan.timeoutMs / 1000} s timeout), ${nc.connectionErrors} connection-level errors`,
    );
    for (const [cause, c] of Object.entries(nc.causes))
      line(
        `  ${cause.padEnd(26)} ${String(c.count).padStart(6)}  [${c.kind}]  ${JSON.stringify(c.byEndpoint)}`,
      );
  }
  if (o.errorSamples.length) {
    line('\nerror samples (up to 3 per endpoint:status; 409 lock conflicts excluded):');
    for (const s of o.errorSamples)
      line(
        `  [+${(s.atMs / 1000).toFixed(1)}s] ${s.status} ${s.method} ${s.path} (${s.endpoint}, ${s.ms} ms)\n      headers ${JSON.stringify(s.headers)}\n      body    ${JSON.stringify(s.body)}`,
      );
  }
  line('\ntimeline (10 s buckets)   from-to     reqs  errors  p95 ms  timeouts  active');
  for (const t of o.timeline)
    line(
      `  ${`${t.fromS}-${t.toS}s`.padEnd(12)} ${String(t.requests).padStart(8)} ${String(t.errors).padStart(7)} ${String(t.p95Ms ?? '-').padStart(7)} ${String(t.timeouts).padStart(9)} ${String(t.activeShoppers).padStart(7)}`,
    );
  const g = o.generator;
  line(
    `\ngenerator: CPU avg ${g.cpu?.avgPercent ?? '?'} %, peak ${g.cpu?.peakPercent ?? '?'} % (${g.cpu?.samples ?? 0} samples); event loop lag p99 peak per worker ${JSON.stringify(g.loopLag.perWorkerPeakP99Ms)} ms`,
  );
  line(
    `\nrealtime fan-out (lock request -> delta received): ${o.realtime.samples} deliveries, p50 ${o.realtime.p50} ms, p95 ${o.realtime.p95} ms, p99 ${o.realtime.p99} ms, max ${o.realtime.max} ms; sockets ${o.realtime.connected}`,
  );
  line(`hot seats: ${JSON.stringify(o.hotSeats)}`);
  if (o.events.length > 1) {
    line(
      '\nevent                         shoppers  hot won/lost  locks  best-av  checkouts  multi-ev  leaked',
    );
    for (const e of o.events) {
      const name = `${e.eventId.slice(0, 8)}${e.eventSlug ? ` ${e.eventSlug}` : ''}`.slice(0, 29);
      line(
        `${name.padEnd(29)} ${String(e.shoppers).padStart(8)} ${`${e.hot.won}/${e.hot.lost}`.padStart(13)} ${String(e.coldLocks).padStart(6)} ${String(e.bestAvailableOk).padStart(8)} ${String(e.checkoutsOk).padStart(10)} ${String(e.multiEventCarts).padStart(9)} ${String(e.leakedLocks).padStart(7)}`,
      );
    }
  }
  const queued = o.counters.queued ?? 0;
  line(
    `waiting room: ${queued > 0 ? `${queued} shopper(s) really queued` : 'waiting room was not active (Warteraum war nicht aktiv), queued 0'}; ENTER timeouts ${o.counters.enter_timeout ?? 0}, ENTER body timeouts ${o.counters.enter_body_timeout ?? 0}`,
  );
  line(`counters: ${JSON.stringify(o.counters)}`);
  const peak = Object.entries(o.resources.peaksDuringRun);
  if (peak.length)
    line(`peaks (sampled /api/metrics): ${JSON.stringify(Object.fromEntries(peak))}`);
  if (o.diagnosis.length) {
    line('\ndiagnosis hint:');
    for (const d of o.diagnosis) line(`  - ${d}`);
  }
  line('\nassertions:');
  for (const c of o.checks)
    line(
      `  ${c.warn ? 'WARN' : c.ok ? 'PASS' : 'FAIL'}  ${c.title}${c.detail ? ` - ${c.detail}` : ''}`,
    );
  for (const d of o.overlapDetails) line(`    CERTAIN overlap: ${JSON.stringify(d)}`);
  for (const d of o.indeterminateOverlapDetails) line(`    indeterminate: ${JSON.stringify(d)}`);
  line(o.passed ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  line(`JSON: ${file}`);
}

main().catch((err) => {
  console.error(`\nERROR: ${redact(err?.stack ?? err, token)}`);
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(2);
});
