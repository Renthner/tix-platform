#!/usr/bin/env node
// Builds the deploy bundle: a self-contained production compose file that references the published
// ghcr.io images and carries its config files inline (Compose `configs: content:`), so a server
// needs only docker-compose.yml + .env.
//
//   node scripts/release/deploy-bundle.mjs <version> <outdir> [--owner <github-owner>] [--repo <owner/name>]
//       writes <outdir>/tix-deploy-<version>/{docker-compose.yml,.env.example,README.md} and
//       <outdir>/tix-deploy-<version>.zip (owner defaults to $GITHUB_REPOSITORY_OWNER, repo to
//       $GITHUB_REPOSITORY); the first two files are also release assets on their own
//   node scripts/release/deploy-bundle.mjs --check
//       fails when deploy/docker-compose.yml and docker-compose.yml disagree on anything but the
//       intentional differences (image source, inline configs instead of file mounts, no published
//       infrastructure ports, redis flags instead of redis.conf); needs `docker compose`, uses
//       `config` only - starts nothing
//
// deploy/docker-compose.yml is a maintained TEMPLATE (the repository has no YAML library, and
// rewriting YAML by regex would break silently): the marker lines __CADDYFILE__ / __MINIO_INIT__
// are replaced by docker/caddy/Caddyfile and docker/minio/init.sh (compose-embed.mjs: indented,
// `$` escaped as `$$`). --check (run in CI) compares the fully resolved service definitions of
// both files and the embedded content with its sources, so they cannot drift apart unnoticed.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  embedFiles,
  missingDirectives,
  redisDirectives,
  releaseComposeProblems,
  stripMaintainerBlock,
} from './compose-embed.mjs';
import { parseVersion } from './version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Repository files embedded in (or translated into) the deploy compose file.
const CADDYFILE = 'docker/caddy/Caddyfile';
const MINIO_INIT = 'docker/minio/init.sh';
const REDIS_CONF = 'docker/redis/redis.conf';
const SOURCES = [CADDYFILE, MINIO_INIT, REDIS_CONF];
// Services whose host ports are published in the base file (local tools) but intentionally not here.
const UNPUBLISHED = ['postgres', 'redis', 'minio'];
const OWNER_PLACEHOLDER = 'TIX_IMAGE_OWNER_DEFAULT';
// storage-credentials is a one-shot that runs on the worker image.
const APP_SERVICES = ['migrate', 'web', 'worker', 'realtime', 'storage-credentials'];

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

// The template without the maintainer block and with the config files embedded (placeholders
// such as the owner are still in place).
function renderCompose() {
  const template = stripMaintainerBlock(
    readFileSync(join(root, 'deploy/docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n'),
  );
  return embedFiles(template, {
    __CADDYFILE__: readFileSync(join(root, CADDYFILE), 'utf8'),
    __MINIO_INIT__: readFileSync(join(root, MINIO_INIT), 'utf8'),
  });
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
    throw new Error(`deploy/docker-compose.yml lacks ${OWNER_PLACEHOLDER}`);
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
  const problems = releaseComposeProblems(composeOut);
  if (problems.length) throw new Error(`generated docker-compose.yml: ${problems.join('; ')}`);
  let readme = fill(readFileSync(join(root, 'deploy/README.md'), 'utf8'));
  if (!repo) readme = readme.replace(/^More: .*\n?/m, '').trimEnd() + '\n';
  readme = readme.replaceAll('__TIX_REPOSITORY__', repo ?? '<owner>/<repo>');

  const files = [
    { path: 'docker-compose.yml', data: Buffer.from(composeOut), mode: 0o644 },
    {
      path: '.env.example',
      data: Buffer.from(fill(readFileSync(join(root, 'deploy/.env.example'), 'utf8'))),
      mode: 0o644,
    },
    { path: 'README.md', data: Buffer.from(readme), mode: 0o644 },
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
  });
  return JSON.parse(out);
}

// Mount targets that the deploy file provides as inline configs instead of bind mounts.
const CONFIG_TARGETS = ['/etc/caddy/Caddyfile', '/usr/local/etc/redis/redis.conf', '/init'];

function normalise(config, dir) {
  const prefix = dir.replaceAll('\\', '/');
  const text = JSON.stringify(config.services).replaceAll('\\\\', '/').replaceAll(prefix, '.');
  const services = JSON.parse(text);
  for (const [name, svc] of Object.entries(services)) {
    if (APP_SERVICES.includes(name)) {
      // Only the image source may differ: built from source vs. pulled from the registry.
      delete svc.image;
      delete svc.build;
      delete svc.pull_policy;
    }
    // Intentional differences of the self-contained deploy file.
    delete svc.configs;
    if (svc.volumes) {
      svc.volumes = svc.volumes.filter((v) => !CONFIG_TARGETS.includes(v.target));
      if (svc.volumes.length === 0) delete svc.volumes;
    }
    if (UNPUBLISHED.includes(name)) delete svc.ports;
    if (name === 'redis') delete svc.command; // flags vs. redis.conf: compared separately
  }
  return { services, volumes: Object.keys(config.volumes ?? {}).sort() };
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
}

function check() {
  const deployDir = join(root, 'deploy');
  const tmp = join(deployDir, '.env.check');
  const rendered = join(deployDir, '.compose.check.yml');
  // The template holds placeholders for the bundle build; give them valid values for `config`.
  writeFileSync(
    tmp,
    readFileSync(join(deployDir, '.env.example'), 'utf8')
      .replaceAll('__TIX_CHANNEL__', 'stable')
      .replaceAll('__TIX_IMAGE_OWNER__', 'owner') +
      // The template does not carry the owner (the compose default holds it); resolve it for the check.
      '\nTIX_IMAGE_OWNER=owner\n',
  );
  try {
    writeFileSync(rendered, renderCompose());
    const base = normalise(composeConfig([join(root, 'docker-compose.yml')], tmp, root), root);
    const deployConfig = composeConfig([rendered], tmp, deployDir);
    const deploy = normalise(deployConfig, deployDir);
    const a = JSON.stringify(base, null, 1);
    const b = JSON.stringify(deploy, null, 1);
    if (a !== b) {
      const al = a.split('\n');
      const bl = b.split('\n');
      const i = al.findIndex((l, n) => l !== bl[n]);
      throw new Error(
        `deploy/docker-compose.yml differs from docker-compose.yml near line ${i + 1}:\n  base:   ${al[i]}\n  deploy: ${bl[i]}`,
      );
    }
    for (const s of APP_SERVICES) {
      const svc = deployConfig.services[s];
      if (
        !/^ghcr\.io\/owner\/tix-(web|worker|realtime):stable$/.test(svc.image) ||
        svc.build ||
        svc.pull_policy !== 'always'
      ) {
        throw new Error(
          `deploy service ${s}: expected a pulled ghcr.io image (pull_policy always)`,
        );
      }
    }
    // The inline configs must resolve (after `$` unescaping) to exactly the source files, and the
    // redis flags must cover every redis.conf directive.
    const embedded = { caddyfile: CADDYFILE, 'minio-init': MINIO_INIT };
    for (const [key, file] of Object.entries(embedded)) {
      const want = normalizeNewlines(readFileSync(join(root, file), 'utf8'));
      // `config` prints the content re-escaped (`$`), the containers see the unescaped file.
      const got = (deployConfig.configs?.[key]?.content ?? '').replaceAll('$$', '$');
      if (got !== want) {
        throw new Error(`deploy config "${key}" does not match ${file}`);
      }
    }
    const missing = missingDirectives(
      deployConfig.services.redis.command,
      redisDirectives(readFileSync(join(root, REDIS_CONF), 'utf8')),
    );
    if (missing.length) {
      throw new Error(
        `deploy redis command lacks directives of ${REDIS_CONF}: ${missing.join(', ')}`,
      );
    }
    const leftovers = releaseComposeProblems(
      renderCompose()
        .replaceAll(OWNER_PLACEHOLDER, 'owner')
        .replaceAll('__TIX_VERSION__', '0.0.0')
        .replaceAll('__TIX_INSTALL_GUIDE__', 'docs/INSTALL.md'),
    );
    if (leftovers.length) throw new Error(`generated docker-compose.yml: ${leftovers.join('; ')}`);
    for (const f of SOURCES) if (!existsSync(join(root, f))) throw new Error(`missing ${f}`);
    console.log(
      'deploy/docker-compose.yml matches docker-compose.yml (services, healthchecks, volumes, dependencies; inline configs equal their sources).',
    );
  } finally {
    rmSync(tmp, { force: true });
    rmSync(rendered, { force: true });
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
