#!/usr/bin/env node
// End-to-end test runner: builds (or reuses) the images of the CURRENT code, starts an isolated
// compose stack (project `tix-e2e`, port 18090), seeds demo data, runs the Playwright suite in
// ./e2e and tears everything down again. Exit code = test result.
//
//   pnpm test:e2e
//   E2E_SKIP_BUILD=1   reuse the images tix-e2e/tix-{web,worker,realtime}:local
//   E2E_KEEP=1         leave the stack running afterwards (the stop command is printed)
//   E2E_PORT=18090     public HTTP port of the stack
//   E2E_BUILD_CACHE_DIR=<dir>  buildx local layer cache (needs the docker-container driver, CI)
//
// It never touches another compose project: every docker compose call carries `-p tix-e2e`,
// explicit `-f` files and `--env-file`, and runs in a temporary directory outside the repository.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = 'tix-e2e';
const PORT = Number(process.env.E2E_PORT ?? 18090);
const TARGETS = ['web', 'worker', 'realtime'];
const image = (t) => `tix-e2e/tix-${t}:local`;
const isWin = process.platform === 'win32';

function log(msg) {
  console.log(`[e2e] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const { allowFail, ...rest } = opts;
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: isWin && cmd !== 'docker' && cmd !== 'node',
    ...rest,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed (exit ${r.status ?? r.signal})`);
  }
  return r.status ?? 1;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const hex = (n = 24) => randomBytes(n).toString('hex');

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'tix-e2e-'));
  const dbPort = await freePort();
  const adminEmail = 'e2e@example.org';
  const adminPassword = `E2e-${hex(10)}-Pw1!`;
  const pgPassword = hex();
  let stackStarted = false;

  const composeArgs = [
    'compose',
    '-p',
    PROJECT,
    '--project-directory',
    dir,
    '-f',
    join(dir, 'docker-compose.yml'),
    '-f',
    join(dir, 'docker-compose.override.yml'),
    '--env-file',
    join(dir, '.env'),
  ];
  const compose = (args, opts = {}) =>
    run('docker', [...composeArgs, ...args], { cwd: dir, ...opts });

  const teardown = () => {
    if (!stackStarted) {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    if (process.env.E2E_KEEP === '1') {
      log(
        `E2E_KEEP=1: stack left running (files in ${dir}); admin ${adminEmail} / ${adminPassword}`,
      );
      log(`stop with: docker ${composeArgs.map((a) => JSON.stringify(a)).join(' ')} down -v`);
      return;
    }
    log('tearing down');
    compose(['down', '-v', '--remove-orphans'], { allowFail: true });
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    // 1. Images of the current code.
    if (process.env.E2E_SKIP_BUILD === '1') {
      log('E2E_SKIP_BUILD=1: reusing existing images');
    } else {
      const cache = process.env.E2E_BUILD_CACHE_DIR;
      for (const t of TARGETS) {
        log(`building ${image(t)}`);
        // `docker build` uses the default builder (docker driver, no cache export); the cached
        // build has to go through `docker buildx build` to use the builder set up by CI.
        const args = cache
          ? ['buildx', 'build', '--target', t, '-t', image(t)]
          : ['build', '--target', t, '-t', image(t)];
        if (cache) {
          args.push(
            '--load',
            '--cache-from',
            `type=local,src=${cache}`,
            '--cache-to',
            `type=local,dest=${cache},mode=max`,
          );
        }
        run('docker', [...args, '.'], { cwd: root });
      }
    }

    // 2. Compose file + env from the deploy template (the same files a real installation uses).
    run(
      'node',
      [join(root, 'scripts/release/deploy-bundle.mjs'), '0.0.0-alpha.1', dir, '--owner', 'e2e'],
      {
        stdio: 'ignore',
      },
    );
    const bundle = join(dir, 'tix-deploy-0.0.0-alpha.1');
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      readFileSync(join(bundle, 'docker-compose.yml')),
    );
    const overrides = {
      COMPOSE_PROJECT_NAME: PROJECT,
      PUBLIC_URL: `http://localhost:${PORT}`,
      SITE_ADDRESS: ':80',
      HTTP_PORT: String(PORT),
      HTTPS_PORT: String(await freePort()),
      POSTGRES_PASSWORD: pgPassword,
      REDIS_PASSWORD: hex(),
      MINIO_ROOT_PASSWORD: hex(),
      S3_SECRET_ACCESS_KEY: hex(),
      APP_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
      SESSION_SECRET: hex(32),
      TIX_CHANNEL: 'next',
    };
    const envText = readFileSync(join(bundle, '.env.example'), 'utf8')
      .split(/\r?\n/)
      .map((line) => {
        const m = /^([A-Z0-9_]+)=/.exec(line);
        return m && m[1] in overrides ? `${m[1]}=${overrides[m[1]]}` : line;
      })
      .join('\n');
    writeFileSync(join(dir, '.env'), envText);
    const svc = (t) => `    image: ${image(t)}\n    pull_policy: never\n`;
    writeFileSync(
      join(dir, 'docker-compose.override.yml'),
      `services:
  postgres:
    ports:
      - "127.0.0.1:${dbPort}:5432"
  migrate:
${svc('worker')}  worker:
${svc('worker')}  web:
${svc('web')}  realtime:
${svc('realtime')}`,
    );

    // 3. Start, create the admin, seed.
    stackStarted = true;
    log('starting the stack');
    compose(['up', '-d', '--wait', '--wait-timeout', '300']);

    log('creating the admin');
    compose(
      [
        'run',
        '--rm',
        '-T',
        '-e',
        `ADMIN_PASSWORD=${adminPassword}`,
        'migrate',
        'node',
        'dist/create-admin.mjs',
        '--email',
        adminEmail,
        '--name',
        'E2E Admin',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );

    log('seeding demo data');
    const databaseUrl = `postgres://tix:${pgPassword}@127.0.0.1:${dbPort}/tix`;
    run('pnpm', ['db:demo'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    // Vorkasse needs a default receiving account.
    const sql = `INSERT INTO bank_accounts (name, account_holder, iban, bic, bank_code, bank_name, currency, is_default_for_bank_transfer, is_active)
VALUES ('E2E account', 'E2E Club', 'DE89370400440532013000', 'COBADEFFXXX', '37040044', 'E2E Bank', 'EUR', true, true)
ON CONFLICT DO NOTHING;`;
    compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'tix',
      '-d',
      'tix',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ]);

    // 4. Tests.
    log('running Playwright');
    return await new Promise((res) => {
      const child = spawn(
        'npx',
        ['playwright', 'test', '-c', 'e2e/playwright.config.ts', ...process.argv.slice(2)],
        {
          cwd: root,
          stdio: 'inherit',
          shell: isWin,
          env: {
            ...process.env,
            E2E_BASE_URL: `http://localhost:${PORT}`,
            E2E_ADMIN_EMAIL: adminEmail,
            E2E_ADMIN_PASSWORD: adminPassword,
            E2E_EVENT_SLUG: 'demo-concert',
          },
        },
      );
      child.on('exit', (c) => res(c ?? 1));
    });
  } finally {
    teardown();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[e2e] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
