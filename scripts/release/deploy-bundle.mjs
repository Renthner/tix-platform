#!/usr/bin/env node
// Builds the deploy bundle (tix-deploy-<version>.zip): a standalone production compose file that
// references the published ghcr.io images, plus the config files it mounts.
//
//   node scripts/release/deploy-bundle.mjs <version> <outdir> [--owner <github-owner>] [--repo <owner/name>]
//       writes <outdir>/tix-deploy-<version>/ and <outdir>/tix-deploy-<version>.zip
//       (owner defaults to $GITHUB_REPOSITORY_OWNER, repo to $GITHUB_REPOSITORY)
//   node scripts/release/deploy-bundle.mjs --check
//       fails when deploy/docker-compose.yml and docker-compose.yml disagree on anything but the
//       image source (needs `docker compose`, uses `config` only - starts nothing)
//
// The compose file is a maintained source file (deploy/docker-compose.yml) rather than generated:
// the repository has no YAML library, and rewriting YAML by regex would break silently when the
// base file changes. --check (run in CI) compares the fully resolved service definitions of both
// files, so they cannot drift apart unnoticed.
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
import { parseVersion } from './version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Files copied from the repository into the bundle (same relative path).
const COPIED = ['docker/caddy/Caddyfile', 'docker/redis/redis.conf', 'docker/minio/init.sh'];
const OWNER_PLACEHOLDER = 'TIX_IMAGE_OWNER_DEFAULT';
const APP_SERVICES = ['migrate', 'web', 'worker', 'realtime'];

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

  const compose = readFileSync(join(root, 'deploy/docker-compose.yml'), 'utf8');
  if (!compose.includes(OWNER_PLACEHOLDER)) {
    throw new Error(`deploy/docker-compose.yml lacks ${OWNER_PLACEHOLDER}`);
  }
  const fill = (text) =>
    text
      .replaceAll(OWNER_PLACEHOLDER, owner)
      .replaceAll('__TIX_IMAGE_OWNER__', owner)
      .replaceAll('__TIX_VERSION__', version)
      // Pre-release bundles default to the channel that exists for them.
      .replaceAll('__TIX_CHANNEL__', v.prerelease ? 'next' : 'stable');
  let readme = fill(readFileSync(join(root, 'deploy/README.md'), 'utf8'));
  readme = repo
    ? readme.replaceAll('__TIX_REPOSITORY__', repo)
    : readme.replace(/^More: .*\n?/m, '').trimEnd() + '\n';

  const files = [
    { path: 'docker-compose.yml', data: Buffer.from(fill(compose)), mode: 0o644 },
    {
      path: '.env.example',
      data: Buffer.from(fill(readFileSync(join(root, 'deploy/.env.example'), 'utf8'))),
      mode: 0o644,
    },
    { path: 'README.md', data: Buffer.from(readme), mode: 0o644 },
    ...COPIED.map((p) => ({
      path: p,
      data: readFileSync(join(root, p)),
      // The exec bit may be lost on a Windows checkout; init.sh is documented as executable.
      mode: p.endsWith('.sh') || statSync(join(root, p)).mode & 0o111 ? 0o755 : 0o644,
    })),
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
  }
  return { services, volumes: Object.keys(config.volumes ?? {}).sort() };
}

function check() {
  const deployDir = join(root, 'deploy');
  const tmp = join(deployDir, '.env.check');
  // The template holds placeholders for the bundle build; give them valid values for `config`.
  writeFileSync(
    tmp,
    readFileSync(join(deployDir, '.env.example'), 'utf8')
      .replaceAll('__TIX_CHANNEL__', 'stable')
      .replaceAll('__TIX_IMAGE_OWNER__', 'owner'),
  );
  try {
    const base = normalise(composeConfig([join(root, 'docker-compose.yml')], tmp, root), root);
    const deployConfig = composeConfig([join(deployDir, 'docker-compose.yml')], tmp, deployDir);
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
    // The documented override (published images on top of the base file) must stay valid.
    const release = join(root, 'docker-compose.release.yml');
    if (existsSync(release)) {
      writeFileSync(
        tmp,
        readFileSync(tmp, 'utf8') + '\nTIX_IMAGE_OWNER=owner\nTIX_IMAGE_TAG=1.0.0\n',
      );
      composeConfig([join(root, 'docker-compose.yml'), release], tmp, root);
    }
    for (const f of COPIED) if (!existsSync(join(root, f))) throw new Error(`missing ${f}`);
    console.log(
      'deploy/docker-compose.yml matches docker-compose.yml (services, healthchecks, volumes, dependencies).',
    );
  } finally {
    rmSync(tmp, { force: true });
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
