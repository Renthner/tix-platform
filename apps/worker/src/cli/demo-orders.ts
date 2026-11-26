import { parseArgs } from 'node:util';
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {
  DEMO_MAX_REAL_ADDRESSES,
  JobQueues,
  createCoreContext,
  generateDemoOrders,
  objectStorageFromEnv,
  type DemoPlan,
  type DemoOrdersResult,
} from '@tix/core';
import { createDb } from '@tix/db';
import { RedisConnections, createKeyspace } from '@tix/redis';
import { createReloadingSecretBox } from '@tix/shared/server';
import { z } from 'zod';
import { loadEnv } from '../env';
import { createLogger } from '../logger';

/**
 * Demo data for DEMO / TEST installations only: creates realistic REGULAR orders (Vorkasse
 * unpaid / paid, multi-event, box office cash / card / complimentary, reduced tariffs, a ticket
 * hand-over) through the normal shop and box-office code paths.
 *
 *   docker compose run --rm tix demo-orders --yes-create-demo-data \
 *     [--count 40] [--real a@x.example,b@y.example,c@z.example] [--events slug1,slug2] [--seed 42]
 *
 * Fake buyers use the reserved domain example.org. The running worker sends the mails from the
 * outbox. Paid orders create GoBD invoices that can never be deleted: take a backup first
 * (Admin -> Backups) – restoring it is the only clean-up.
 *
 * The environment is taken ONLY from the process (the image's supervisor / compose passes it);
 * there is deliberately no fallback to a .env file, so a dev workspace can never hit the wrong
 * database by accident. In an interactive terminal the printed plan must be confirmed as well.
 *
 * Exit codes: 0 done, 1 error / no event usable / no order could be created, 2 invalid arguments,
 * missing environment or missing / declined confirmation.
 */

/** Must be set explicitly in the process environment (no .env fallback). */
const REQUIRED_ENV = [
  'DATABASE_URL',
  'REDIS_URL',
  'APP_URL',
  'APP_ENCRYPTION_KEYS',
  'SESSION_SECRET',
] as const;

const USAGE = `Usage: demo-orders --yes-create-demo-data [--count 40] [--real a@x,b@y,c@z] [--events slug1,slug2] [--seed 42]

  --yes-create-demo-data  required: confirms that this is a demo/test installation
  --count <n>             orders with fake buyers (1-500, default 40)
  --real <list>           up to ${DEMO_MAX_REAL_ADDRESSES} real e-mail addresses, comma separated:
                            A: Vorkasse unpaid + paid + multi-event paid, passes a ticket on to B
                            B: Vorkasse paid + receives the ticket from A
                            C: Vorkasse paid + unpaid (e.g. to test "change buyer e-mail")
  --events <list>         only these event slugs (default: all published events on sale)
  --seed <n>              random seed (same seed + same data = same orders)`;

const listOf = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const argsSchema = z.object({
  confirmed: z.literal(true, { error: 'missing --yes-create-demo-data' }),
  count: z.coerce.number().int().min(1).max(500),
  real: z
    .array(z.email().transform((e) => e.toLowerCase()))
    .max(DEMO_MAX_REAL_ADDRESSES)
    .refine((list) => new Set(list).size === list.length, 'the real addresses must differ'),
  events: z.array(z.string().regex(/^[a-z0-9-]{1,200}$/, 'invalid event slug')),
  seed: z.coerce
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
});

function parseCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        'yes-create-demo-data': { type: 'boolean', default: false },
        count: { type: 'string' },
        real: { type: 'string' },
        events: { type: 'string' },
        seed: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(USAGE);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const parsed = argsSchema.safeParse({
    confirmed: values['yes-create-demo-data'] || undefined,
    count: values.count ?? 40,
    real: listOf(values.real),
    events: listOf(values.events),
    seed: values.seed ?? randomInt(1, 2 ** 31 - 1),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      console.error(`${issue.path.join('.') || 'arguments'}: ${issue.message}`);
    }
    console.error(USAGE);
    process.exit(2);
  }
  return parsed.data;
}

const euro = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;

function printPlan(plan: DemoPlan, count: number): void {
  console.log('');
  console.log('DEMO ORDERS – for demo/test installations only');
  console.log(`Shop:   ${plan.appUrl ?? '(APP_URL not set)'}`);
  console.log(`Seed:   ${plan.seed}  (repeat with --seed ${plan.seed})`);
  console.log('Events used (published, on sale; at most 40 % of the free capacity):');
  for (const e of plan.events) {
    console.log(
      `  - ${e.title} [${e.slug}]  free ${e.free}, up to ${e.budget} tickets, waiting room ${e.queueMode}` +
        (e.vorkasse ? '' : `, Vorkasse unavailable (${e.vorkasseReason}): box office only`),
    );
  }
  for (const e of plan.skippedEvents) console.log(`  (skipped ${e.slug}: ${e.reason})`);
  console.log(`Planned orders with fake buyers (@example.org): ${count}`);
  console.log(
    `  Vorkasse unpaid ${plan.mix.UNPAID}, Vorkasse paid ${plan.mix.PAID}, multi-event ${plan.mix.MULTI_EVENT}, box office ${plan.mix.BOX_OFFICE}`,
  );
  for (const r of plan.real)
    console.log(`Real address ${r.label} ${r.email}: ${r.orders.join('; ')}`);
  if (plan.boxOfficeUser)
    console.log(`Box office sales are recorded as ${plan.boxOfficeUser.email}`);
  for (const n of plan.notes) console.log(`Note: ${n}`);
  console.log('');
  console.log(
    'WARNING: paid orders create GoBD invoices that cannot be deleted. Take a backup first',
  );
  console.log('(Admin -> Backups); restoring it is the only way to remove the demo data again.');
  console.log('');
}

function printSummary(result: DemoOrdersResult): void {
  console.log('');
  console.log(`Created ${result.orders.length} order(s):`);
  for (const o of result.orders) {
    console.log(
      [
        o.orderNumber.padEnd(16),
        o.status.padEnd(16),
        o.method.padEnd(13),
        `${o.tickets} ticket(s)`.padEnd(11),
        euro(o.totalGross, o.currency).padStart(12),
        ` ${o.real ? `[${o.real}] ` : ''}${o.buyer}`,
        ` – ${o.events.join(' + ')}`,
        o.note ? ` (${o.note})` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
  const real = result.orders.filter((o) => o.real);
  if (real.length > 0) {
    console.log('');
    console.log('Orders of the real addresses:');
    for (const label of ['A', 'B', 'C'] as const) {
      const own = real.filter((o) => o.real === label);
      if (own.length === 0) continue;
      console.log(
        `  ${label} ${own[0]!.buyer}: ${own.map((o) => `${o.orderNumber} (${o.status})`).join(', ')}`,
      );
    }
  }
  if (result.transfer?.status === 'DONE') {
    console.log(`Ticket of ${result.transfer.fromOrder} passed on to ${result.transfer.to}`);
  }
  if (result.failures.length > 0) {
    console.log('');
    console.log(`Skipped ${result.failures.length} order(s):`);
    for (const f of result.failures) console.log(`  ${f.scenario} for ${f.buyer}: ${f.reason}`);
  }
  for (const n of result.notes) console.log(`Note: ${n}`);
  console.log('');
  console.log(
    'E-mails are sent by the running worker (fake @example.org buyers are not delivered).',
  );
}

/** Interactive terminals must confirm the printed plan; scripts rely on --yes-create-demo-data. */
async function confirmPlan(): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Create these orders? [y/N] ');
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = parseCli();
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    console.error(`Missing environment: ${missing.join(', ')}.`);
    console.error(
      'demo-orders never reads a .env file. Run it inside the installation (docker compose run --rm tix demo-orders …)',
    );
    console.error('or set these variables explicitly for the target demo/test system.');
    return 2;
  }
  const env = loadEnv();
  const logger = createLogger(process.env.LOG_LEVEL ?? 'warn');
  const dbHandle = createDb({
    connectionString: env.DATABASE_URL,
    poolMax: 4,
    applicationName: 'tix-demo-orders',
  });
  const redis = new RedisConnections(env.REDIS_URL, { serviceName: 'demo-orders', logger });
  const keys = createKeyspace(env.REDIS_KEY_PREFIX);
  // Same queues and prefix as the worker: the order mails / documents jobs are picked up by it.
  const jobs = new JobQueues(redis.bullmq, keys.bullPrefix());
  let declined = false;
  try {
    const ctx = createCoreContext({
      db: dbHandle.db,
      redis: redis.command,
      publisher: redis.publisher,
      keyPrefix: env.REDIS_KEY_PREFIX,
      sessionSecret: env.SESSION_SECRET,
      appUrl: env.APP_URL,
      secrets: createReloadingSecretBox(env.APP_ENCRYPTION_KEYS),
      storage: objectStorageFromEnv(env),
      jobs,
      logger,
    });
    const result = await generateDemoOrders(ctx, {
      count: args.count,
      real: args.real,
      eventSlugs: args.events.length ? args.events : undefined,
      seed: args.seed,
      onPlan: async (plan) => {
        printPlan(plan, args.count);
        declined = !(await confirmPlan());
        if (declined) return false;
        console.log('Creating orders …');
        return true;
      },
      log: (line) => console.log(`  ${line}`),
    });
    if (declined) {
      console.error('Aborted – nothing was created.');
      return 2;
    }
    if (result.aborted) {
      for (const e of result.plan.skippedEvents) console.error(`skipped ${e.slug}: ${e.reason}`);
      for (const n of result.notes) console.error(n);
      return 1;
    }
    printSummary(result);
    // Nothing could be created at all (e.g. Vorkasse not configured): signal it to scripts.
    return result.orders.length === 0 && result.failures.length > 0 ? 1 : 0;
  } finally {
    await jobs.close().catch(() => undefined);
    await redis.close().catch(() => undefined);
    await dbHandle.close().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
