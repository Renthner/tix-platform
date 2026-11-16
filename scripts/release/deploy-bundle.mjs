#!/usr/bin/env node
// Builds the deploy bundle: the production compose file (three services: tix, postgres, redis) that
// references the published ghcr.io image, plus .env.example, README and the update script.
//
//   node scripts/release/deploy-bundle.mjs <version> <outdir> [--owner <github-owner>] [--repo <owner/name>]
//       writes <outdir>/tix-deploy-<version>/{docker-compose.yml,.env.example,
//       docker-compose.s3.example.yml,README.md,tix-update.sh} and <outdir>/tix-deploy-<version>.zip
//       (owner defaults to $GITHUB_REPOSITORY_OWNER, repo to $GITHUB_REPOSITORY); docker-compose.yml,
//       .env.example and tix-update.sh are also release assets on their own
//   node scripts/release/deploy-bundle.mjs --check
//       validates the template and the S3 example with `docker compose config` (starts nothing):
//       services, image, volumes, no embedded configs (see compose-checks.mjs)
//
// docker/deploy/docker-compose.yml is a maintained TEMPLATE (the repository has no YAML library, and
// rewriting YAML by regex would break silently): the maintainer block is stripped and the
// placeholders (image owner, version, install guide) are filled in.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  deployConfigProblems,
  releaseComposeProblems,
  s3ExampleProblems,
  stripMaintainerBlock,
} from './compose-checks.mjs';
import { parseVersion } from './version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER_PLACEHOLDER = 'TIX_IMAGE_OWNER_DEFAULT';

// Minimal ZIP writer (deflate, unix permissions kept; no dependency, no `zip` binary needed).
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const time = 0;
  const date = ((2020 - 1980) << 9) | (1 << 5) | 1; // fixed timestamp: reproducible archive
  for (const { name, data, mode } of entries) {
    const nameBuf = Buffer.from(name);
    const deflated = deflateRawSync(data);
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// The template without the maintainer block (placeholders are still in place).
function renderCompose() {
  return stripMaintainerBlock(
    readFileSync(join(root, 'docker/deploy/docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n'),
  );
}

function build(version, outdir, owner, repo) {
  const v = parseVersion(version);
  if (!owner || !/^[a-z0-9][a-z0-9-]*$/.test(owner)) {
    throw new Error(
      'Image owner missing or invalid: pass --owner <github-owner> (lower case) or set GITHUB_REPOSITORY_OWNER',
    );
  }
  const name = `tix-deploy-${version}`;
  const dir = resolve(outdir, name);
  rmSync(dir, { recursive: true, force: true });

  const compose = renderCompose();
  if (!compose.includes(OWNER_PLACEHOLDER)) {
    throw new Error(`docker/deploy/docker-compose.yml lacks ${OWNER_PLACEHOLDER}`);
  }
  const fill = (text) =>
    text
      .replaceAll(OWNER_PLACEHOLDER, owner)
      .replaceAll('__TIX_IMAGE_OWNER__', owner)
      .replaceAll('__TIX_VERSION__', version)
      .replaceAll(
        '__TIX_INSTALL_GUIDE__',
        repo
          ? `https://github.com/${repo}/blob/v${version}/docs/INSTALL.md`
          : 'docs/INSTALL.md in the repository',
      )
      // Pre-release bundles default to the channel that exists for them.
      .replaceAll('__TIX_CHANNEL__', v.prerelease ? 'next' : 'stable');
  const composeOut = fill(compose);
  // The admin compares this with the running app version (docker-compose.yml drift warning) and
  // tix-update.sh reads it for its downgrade guard.
  if (!composeOut.includes(`TIX_COMPOSE_VERSION: ${version}`)) {
    throw new Error(
      'docker/deploy/docker-compose.yml lacks "TIX_COMPOSE_VERSION: __TIX_VERSION__"',
    );
  }
  const problems = releaseComposeProblems(composeOut);
  if (problems.length) throw new Error(`generated docker-compose.yml: ${problems.join('; ')}`);
  let readme = fill(readFileSync(join(root, 'docker/deploy/README.md'), 'utf8'));
  if (!repo) readme = readme.replace(/^More: .*\n?/m, '').trimEnd() + '\n';
  readme = readme.replaceAll('__TIX_REPOSITORY__', repo ?? '<owner>/<repo>');

  const files = [
    { path: 'docker-compose.yml', data: Buffer.from(composeOut), mode: 0o644 },
    {
      path: '.env.example',
      data: Buffer.from(fill(readFileSync(join(root, 'docker/deploy/.env.example'), 'utf8'))),
      mode: 0o644,
    },
    {
      path: 'docker-compose.s3.example.yml',
      data: Buffer.from(
        fill(readFileSync(join(root, 'docker/deploy/docker-compose.s3.example.yml'), 'utf8')),
      ),
      mode: 0o644,
    },
    { path: 'README.md', data: Buffer.from(readme), mode: 0o644 },
    {
      path: 'tix-update.sh',
      data: Buffer.from(
        fill(readFileSync(join(root, 'docker/deploy/tix-update.sh'), 'utf8')).replaceAll(
          '__TIX_REPOSITORY__',
          repo ?? '__TIX_REPOSITORY__',
        ),
      ),
      mode: 0o755,
    },
  ];
  for (const f of files) {
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.data);
    try {
      chmodSync(target, f.mode);
    } catch {
      // not supported on this file system
    }
  }
  const zipPath = resolve(outdir, `${name}.zip`);
  writeFileSync(
    zipPath,
    zip(files.map((f) => ({ name: `${name}/${f.path}`, data: f.data, mode: f.mode }))),
  );
  return { zipPath, files: files.map((f) => f.path) };
}

function composeConfig(files, envFile, projectDir) {
  const args = ['compose', '--project-directory', projectDir];
  for (const f of files) args.push('-f', f);
  args.push('--env-file', envFile, 'config', '--format', 'json');
  const out = execFileSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, COMPOSE_PROJECT_NAME: 'tix-check' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

// The merged file keeps the S3 additions; the base checks only apply to the base services/volumes.
function withoutS3(merged) {
  const services = { ...merged.services };
  delete services.minio;
  delete services['minio-init'];
  const volumes = { ...merged.volumes };
  delete volumes['minio-data'];
  const tix = { ...services.tix, depends_on: { ...services.tix.depends_on } };
  delete tix.depends_on.minio;
  delete tix.depends_on['minio-init'];
  services.tix = tix;
  return { ...merged, services, volumes };
}

function check() {
  const deployDir = join(root, 'docker/deploy');
  // The compose file reads .env from its own directory: check in a throw-away one.
  const work = mkdtempSync(join(tmpdir(), 'tix-compose-check-'));
  const envFile = join(work, '.env');
  const rendered = join(work, 'docker-compose.yml');
  const s3File = join(work, 'docker-compose.s3.yml');
  // The templates hold placeholders for the bundle build; give them valid values for `config`.
  const fillCheck = (text) =>
    text
      .replaceAll(OWNER_PLACEHOLDER, 'owner')
      .replaceAll('__TIX_IMAGE_OWNER__', 'owner')
      .replaceAll('__TIX_VERSION__', '0.0.0')
      .replaceAll('__TIX_INSTALL_GUIDE__', 'docs/INSTALL.md')
      .replaceAll('__TIX_CHANNEL__', 'stable');
  try {
    const compose = fillCheck(renderCompose());
    const leftovers = releaseComposeProblems(compose);
    if (leftovers.length) throw new Error(`generated docker-compose.yml: ${leftovers.join('; ')}`);
    writeFileSync(rendered, compose);
    writeFileSync(
      s3File,
      fillCheck(readFileSync(join(deployDir, 'docker-compose.s3.example.yml'), 'utf8')),
    );
    // .env.example as it is shipped, plus the values the S3 example needs.
    writeFileSync(
      envFile,
      fillCheck(readFileSync(join(deployDir, '.env.example'), 'utf8')) +
        '\nMINIO_ROOT_USER=minio\nMINIO_ROOT_PASSWORD=secret\n',
    );
    const opts = { owner: 'owner', version: 'stable' };
    const problems = deployConfigProblems(composeConfig([rendered], envFile, work), opts);
    const merged = composeConfig([rendered, s3File], envFile, work);
    problems.push(...deployConfigProblems(withoutS3(merged), opts), ...s3ExampleProblems(merged));
    if (problems.length) throw new Error(`deploy compose files: ${problems.join('; ')}`);

    // A .env of the three-image layout (TIX_CHANNEL, PUBLIC_URL, REDIS_PASSWORD, no TIX_VERSION)
    // must make `docker compose config` fail: the OLD tix-update.sh then stops before replacing
    // anything ("nothing was changed").
    writeFileSync(
      envFile,
      'PUBLIC_URL=http://localhost:8080\nPOSTGRES_PASSWORD=x\nREDIS_PASSWORD=x\nTIX_CHANNEL=stable\nSESSION_SECRET=x\n' +
        'APP_ENCRYPTION_KEYS=k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n',
    );
    let refused = false;
    try {
      composeConfig([rendered], envFile, work);
    } catch (err) {
      refused = /MIGRATE-SINGLE-IMAGE/.test(String(err.stderr ?? err.message));
    }
    if (!refused) {
      throw new Error(
        'a .env of the three-image layout must be refused with a pointer to docs/MIGRATE-SINGLE-IMAGE.md',
      );
    }
    console.log('docker/deploy/docker-compose.yml and the S3 example are consistent.');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
try {
  if (args[0] === '--check') {
    check();
  } else if (args.length >= 2 && !args[0].startsWith('-')) {
    const owner = (opt('--owner') ?? process.env.GITHUB_REPOSITORY_OWNER ?? '').toLowerCase();
    const repo = opt('--repo') ?? process.env.GITHUB_REPOSITORY;
    const { zipPath, files } = build(args[0].replace(/^v/, ''), args[1], owner, repo);
    console.log(`${zipPath}\n  ${files.join('\n  ')}`);
  } else {
    console.error('usage: deploy-bundle.mjs <version> <outdir> [--owner o] [--repo o/r] | --check');
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
