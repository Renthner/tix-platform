// node --test scripts/release
// Runs docker/deploy/tix-update.sh (POSIX sh + awk + curl) against a local fake of the GitHub API and the
// release downloads: channel resolution must pick the HIGHEST SemVer, never the API list order.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '../../docker/deploy/tix-update.sh');
const have = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const skip = !(have('awk') && have('curl') && have('sha256sum'))
  ? 'needs sh, awk, curl and sha256sum'
  : false;

// Deliberately NOT in version order (the API lists by creation date): 1.0.1 after 1.1.0.
const TAGS = [
  'v1.1.0',
  'v1.0.1',
  'v1.2.0-alpha.2',
  'v1.2.0-alpha.10',
  'v1.2.0-beta.1',
  'v1.2.0-rc.1',
  'v1.0.0',
  'v1.10.0-alpha.1',
  'v2.0.0-rc.2',
  'v1.2.0-rc.10',
  'v1.2.0-dev.5',
  'not-a-version',
];

const composeBody = (version) => `services: {}\nx-env:\n  TIX_COMPOSE_VERSION: ${version}\n`;
let server;
let base;
let dir;

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/repos/o/r/releases')) {
      res.end(JSON.stringify(TAGS.map((tag_name) => ({ tag_name }))));
      return;
    }
    const m = /^\/o\/r\/releases\/download\/v([^/]+)\/(.+)$/.exec(url);
    if (!m) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const compose = composeBody(m[1]);
    if (m[2] === 'docker-compose.yml') res.end(compose);
    else if (m[2] === 'SHA256SUMS.txt') {
      res.end(`${createHash('sha256').update(compose).digest('hex')}  docker-compose.yml\n`);
    } else res.statusCode = 404;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'tix-update-'));
  copyFileSync(script, join(dir, 'tix-update.sh'));
});

after(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(args, current = '1.0.0', env = {}, compose = composeBody(current)) {
  writeFileSync(join(dir, 'docker-compose.yml'), compose);
  // Async child: spawnSync would block the event loop that serves the fake API.
  return new Promise((resolve) => {
    const child = spawn('sh', [join(dir, 'tix-update.sh'), ...args], {
      env: {
        ...process.env,
        TIX_REPOSITORY: 'o/r',
        TIX_API_URL: base,
        TIX_DOWNLOAD_URL: base,
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

const target = (out) => /release (\S+) of o\/r/.exec(out)?.[1];

for (const [arg, expected] of [
  ['stable', 'v1.1.0'],
  ['latest', 'v1.1.0'],
  ['next', 'v2.0.0-rc.2'],
  ['alpha', 'v1.10.0-alpha.1'],
  ['beta', 'v1.2.0-beta.1'],
  ['rc', 'v2.0.0-rc.2'],
  ['1', 'v1.1.0'],
  ['1.0', 'v1.0.1'],
  ['1.1', 'v1.1.0'],
  ['1.0.0', 'v1.0.0'],
  ['v1.2.0-rc.10', 'v1.2.0-rc.10'],
]) {
  test(`channel "${arg}" resolves to ${expected}`, { skip }, async () => {
    const { status, out } = await run(['--dry-run', arg]);
    assert.equal(status, 0, out);
    assert.equal(target(out), expected, out);
  });
}

test('1.0.1 published after 1.1.0 does not become "stable"', { skip }, async () => {
  const { out } = await run(['--dry-run', 'stable']);
  assert.equal(target(out), 'v1.1.0');
});

test('numeric parts compare as numbers (alpha.10 > alpha.2, 1.10 > 1.9)', { skip }, async () => {
  const { out } = await run(['--dry-run', 'alpha']);
  assert.equal(target(out), 'v1.10.0-alpha.1');
});

test('unknown or malicious arguments are rejected before any request', { skip }, async () => {
  for (const bad of ['foo', '1.2.3;id', '1.2.3-dev.1', '../x', '1.2.3.4', '$(id)']) {
    const { status, out } = await run(['--dry-run', bad]);
    assert.notEqual(status, 0, `${bad}: ${out}`);
    assert.match(out, /unknown version or channel/, bad);
  }
});

test('a lower version than the compose file is refused without --force', { skip }, async () => {
  const refused = await run(['1.0.0'], '1.1.0');
  assert.notEqual(refused.status, 0, refused.out);
  assert.match(refused.out, /LOWER/);
  assert.match(refused.out, /refusing to go from 1\.1\.0 to 1\.0\.0/);
  // A dry run only warns.
  const dry = await run(['--dry-run', '1.0.0'], '1.1.0');
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /LOWER/);
  // Equal or higher versions are not flagged.
  const same = await run(['--dry-run', '1.1.0'], '1.1.0');
  assert.doesNotMatch(same.out, /LOWER/);
  const higher = await run(['--dry-run', '1.1.0'], '1.0.1-rc.1');
  assert.doesNotMatch(higher.out, /LOWER/);
});

test('a pre-release is lower than its final version', { skip }, async () => {
  const { out } = await run(['--dry-run', '1.2.0-rc.1'], '1.2.0');
  assert.match(out, /LOWER/);
});

const OLD_LAYOUT = [
  'services:',
  '  migrate:',
  '    image: ghcr.io/o/tix-worker:stable',
  '  web:',
  '    image: ghcr.io/o/tix-web:stable',
  '  realtime:',
  '    image: ghcr.io/o/tix-realtime:stable',
  '',
].join('\n');

test('the three-image layout is never replaced: pointer to the guide', { skip }, async () => {
  const { status, out } = await run(['1.1.0'], '1.0.0', {}, OLD_LAYOUT);
  assert.notEqual(status, 0, out);
  assert.match(out, /three-image layout/);
  assert.match(out, /MIGRATE-SINGLE-IMAGE\.md/);
  assert.match(out, /Nothing was changed/);
  // Stops before any download: no release was looked up.
  assert.doesNotMatch(out, /Target:/);
  const dry = await run(['--dry-run', 'stable'], '1.0.0', {}, OLD_LAYOUT);
  assert.notEqual(dry.status, 0, dry.out);
});

test(
  'a single-image compose with a MinIO service (S3 mode) is still updated',
  { skip },
  async () => {
    const s3 = [
      'services:',
      '  tix:',
      '    image: ghcr.io/o/tix:${TIX_VERSION}',
      '  minio:',
      '    image: minio',
      '',
    ].join('\n');
    const { status, out } = await run(['--dry-run', 'stable'], '1.0.0', {}, s3);
    assert.equal(status, 0, out);
    assert.equal(target(out), 'v1.1.0');
  },
);

test('the channel comes from TIX_VERSION in .env', { skip }, async () => {
  writeFileSync(join(dir, '.env'), 'TIX_CHANNEL=stable\nTIX_VERSION=1.0\n');
  try {
    const { status, out } = await run(['--dry-run']);
    assert.equal(status, 0, out);
    assert.equal(target(out), 'v1.0.1');
  } finally {
    unlinkSync(join(dir, '.env'));
  }
});
