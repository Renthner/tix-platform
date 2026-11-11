// Runs ONE load scenario against a running shop and checks its invariants.
//
//   node scripts/load/run-scenario.mjs <seat-rush|best-available|checkout-rush|waiting-room> \
//        --target http://localhost:18080 --vus 1200 --event-id <uuid> \
//        --database-url postgres://... --redis-url redis://... [--fake-ip] --confirm-non-production
//
// Exit code 0 = all invariants held, 1 = an invariant was violated, 2 = the run itself failed.
// See docs/LOAD-TEST.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  Vu,
  Metrics,
  buildConfig,
  openDb,
  openRedis,
  parseArgs,
  scanKeys,
  keyspace,
} from './lib/common.mjs';
import { Report } from './lib/invariants.mjs';
import { loadWorld } from './lib/world.mjs';

const args = parseArgs(process.argv.slice(2));
const scenarioName = args._[0];
const scenarios = {
  'seat-rush': () => import('./scenarios/seat-rush.mjs'),
  'best-available': () => import('./scenarios/best-available.mjs'),
  'checkout-rush': () => import('./scenarios/checkout-rush.mjs'),
  'waiting-room': () => import('./scenarios/waiting-room.mjs'),
};
if (!scenarios[scenarioName]) {
  console.error(`Usage: run-scenario.mjs <${Object.keys(scenarios).join('|')}> [options]`);
  process.exit(2);
}

const cfg = buildConfig(args);
const log = (msg) => console.log(`[${scenarioName}] ${msg}`);
const resultsDir = new URL('./results/', import.meta.url);
mkdirSync(resultsDir, { recursive: true });

// Latency targets (reported, never failing the run - see docs/LOAD-TEST.md).
const P95_TARGET_MS = {
  LOCK_HOT: 500,
  LOCK_RANDOM: 500,
  LOCK: 500,
  BEST_AVAILABLE: 800,
  CHECKOUT: 2000,
};

async function main() {
  if (!cfg.databaseUrl || !cfg.redisUrl) {
    console.error(
      'Invariant checks need --database-url and --redis-url (or LOAD_DATABASE_URL / LOAD_REDIS_URL).',
    );
    process.exit(2);
  }
  // These scenarios create orders and lock seats: never against a system that was not explicitly
  // confirmed as non-production. The orchestrator's own isolated stack proves itself through a
  // random token that it wrote into the throwaway database and Redis (verified below).
  if (!args['confirm-non-production'] && !(args.isolated && args['isolation-token'])) {
    console.error(
      'Refusing to run: this creates orders and locks seats. Pass --confirm-non-production if the target is NOT a production system with real payments.',
    );
    process.exit(2);
  }
  const db = await openDb(cfg.databaseUrl);
  const redis = openRedis(cfg.redisUrl);
  let eventId = args['event-id'];
  if (!eventId) {
    const slug = args['event-slug'] ?? 'demo-concert';
    const { rows } = await db.query('SELECT id FROM events WHERE slug = $1', [slug]);
    eventId = rows[0]?.id;
  }
  if (!eventId) throw new Error('Event not found: pass --event-id or --event-slug');

  const queueConfig = { threshold: 100, batch: 50, intervalSeconds: 5 };
  if (args.isolated) await prepareIsolated(db, redis, eventId, scenarioName, queueConfig);

  const probe = new Vu(cfg, 3_000_000, new Metrics());
  await probe.call('SETUP_ENTER', 'POST', `/api/events/${eventId}/enter`);
  const world = await loadWorld(cfg, probe, eventId);
  log(
    `event ${eventId}: ${world.usable.length} plain seats (${world.hotSeats.length} hot), standing ${world.ga?.available ?? 0}, ${cfg.vus} virtual users -> ${cfg.base}`,
  );

  const report = new Report(scenarioName);
  const ctx = { cfg, args, db, redis, world, eventId, report, log, queueConfig };
  const scenario = await scenarios[scenarioName]();
  const t0 = performance.now();
  const result = await scenario.run(ctx);
  const rush = result.rush;

  // generic checks
  report.check(
    `HTTP 5xx / network error rate < 1 % (${rush.failures5xxOrNetwork} of ${rush.requests})`,
    rush.failureRate < 0.01,
    `${(rush.failureRate * 100).toFixed(2)} %`,
  );
  const rateLimited = Object.values(rush.endpoints).reduce((n, e) => n + (e.statuses[429] ?? 0), 0);
  report.check(
    'no request was rate limited (429) - otherwise the per-IP limits distorted the test',
    rateLimited === 0,
    `${rateLimited} x HTTP 429 (use --fake-ip with the load proxy or raise the limits)`,
  );

  const targets = Object.entries(rush.endpoints)
    .filter(([label]) => P95_TARGET_MS[label])
    .map(([label, e]) => ({
      label,
      p95: e.p95,
      target: P95_TARGET_MS[label],
      met: e.p95 <= P95_TARGET_MS[label],
    }));

  const out = {
    scenario: scenarioName,
    startedAt: new Date().toISOString(),
    target: cfg.base,
    vus: cfg.vus,
    eventId,
    totalSeconds: Math.round((performance.now() - t0) / 100) / 10,
    ...result,
    latencyTargets: targets,
    invariants: report.checks,
    passed: report.failed.length === 0,
  };
  writeFileSync(new URL(`${scenarioName}.json`, resultsDir), JSON.stringify(out, null, 2));
  print(out);
  await db.end();
  redis.disconnect();
  process.exit(out.passed ? 0 : 1);
}

/** Throwaway-stack preparation: queue mode per scenario, orphan rule off, stale queue keys gone. */
async function prepareIsolated(db, redis, eventId, scenario, q) {
  const { rows } = await db.query(
    `SELECT current_database() AS db, shobj_description(oid, 'pg_database') AS marker
       FROM pg_database WHERE datname = current_database()`,
  );
  const token = String(args['isolation-token'] ?? '');
  if (!token || rows[0].marker !== `tix-load-isolated:${token}`) {
    throw new Error(
      "Refusing --isolated: the database does not carry this run's isolation marker.",
    );
  }
  if ((await redis.get('tix-load-isolated')) !== token) {
    throw new Error("Refusing --isolated: Redis does not carry this run's isolation marker.");
  }
  const url = new URL(cfg.databaseUrl);
  log(`isolated setup on database "${rows[0].db}" (${url.host})`);
  await db.query('UPDATE events SET orphan_seat_rule_enabled = false WHERE id = $1', [eventId]);
  await db.query('DELETE FROM queue_configs WHERE event_id = $1', [eventId]);
  // Vorkasse needs a default bank account (public example IBAN, no real account).
  await db.query(
    `INSERT INTO bank_accounts (name, account_holder, iban, currency, is_default_for_bank_transfer)
     SELECT 'Load test', 'Load Test e.V.', 'DE89370400440532013000', 'EUR', true
      WHERE NOT EXISTS (SELECT 1 FROM bank_accounts WHERE is_default_for_bank_transfer)
     ON CONFLICT DO NOTHING`,
  );
  if (scenario === 'waiting-room') {
    await db.query(
      `INSERT INTO queue_configs (event_id, mode, active_session_threshold, admission_batch_size,
         admission_interval_seconds, pass_token_ttl_seconds)
       VALUES ($1, 'AUTO_THRESHOLD', $2, $3, $4, 900)`,
      [eventId, q.threshold, q.batch, q.intervalSeconds],
    );
  }
  const stale = await scanKeys(redis, keyspace(cfg.prefix, eventId).queuePattern);
  if (stale.length) await redis.del(...stale);
  // wait for the 3 s event cache of the web container
  await new Promise((r) => setTimeout(r, 3500));
}

function print(o) {
  const line = (s = '') => console.log(s);
  line(`\n=== ${o.scenario}: ${o.vus} virtual users, rush ${o.rush.durationMs} ms ===`);
  line(
    `requests ${o.rush.requests}  (${o.rush.requestsPerSecond}/s)  5xx+network ${o.rush.failures5xxOrNetwork}`,
  );
  line('endpoint                 reqs     p50     p95     p99     max   statuses');
  for (const [label, e] of Object.entries(o.rush.endpoints)) {
    line(
      `${label.padEnd(22)} ${String(e.requests).padStart(6)} ${String(e.p50).padStart(7)} ${String(e.p95).padStart(7)} ${String(e.p99).padStart(7)} ${String(e.max).padStart(7)}   ${JSON.stringify(e.statuses)}`,
    );
    const codes = Object.keys(e.codes);
    if (codes.length) line(`${' '.repeat(22)} codes ${JSON.stringify(e.codes)}`);
  }
  line('\nlatency targets (informational):');
  for (const t of o.latencyTargets)
    line(`  ${t.met ? 'ok  ' : 'MISS'} ${t.label} p95 ${t.p95} ms (target ${t.target} ms)`);
  line('\ndetails: ' + JSON.stringify({ ...o.details, cursorSamples: undefined }));
  line('\ninvariants:');
  for (const c of o.invariants)
    line(
      `  ${c.skipped ? 'SKIP' : c.ok ? 'PASS' : 'FAIL'}  ${c.title}${c.detail ? ` - ${c.detail}` : ''}`,
    );
  line(o.passed ? '\nRESULT: PASS' : '\nRESULT: FAIL (invariant violated)');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
