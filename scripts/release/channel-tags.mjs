#!/usr/bin/env node
// Moving image tags ("channels") a release must be published under.
//
//   node scripts/release/channel-tags.mjs <version> [--tags v1.0.0,v1.1.0-alpha.1]
//
// Prints one tag per line. Without --tags, all `v*` tags of the checked-out repository are used
// (the workflow checks out with fetch-depth 0). The exact version tag is not printed; it is pushed
// by the build.
//
// Every moving tag belongs to a group of versions. A version moves the tag only if it has the
// highest SemVer precedence in that group, so publishing an older line (1.0.1 after 1.1.0) never
// pulls `latest` backwards.
//
//   next              every release (pre-release or stable)
//   alpha|beta|rc     pre-releases of that stage
//   latest, stable    stable releases (always moved together)
//   X, X.Y            stable releases of that major / minor
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareVersions, parseVersion } from './version.mjs';

// Groups a version belongs to; the key is the moving tag name (latest and stable share one group).
export function groupsOf(v) {
  const groups = ['next'];
  if (v.prerelease) {
    groups.push(v.tag);
  } else {
    groups.push('latest', `${v.major}`, `${v.major}.${v.minor}`);
  }
  return groups;
}

export function movingTags(version, allVersions) {
  const current = parseVersion(version);
  const others = [];
  for (const raw of allVersions) {
    try {
      others.push(parseVersion(raw));
    } catch {
      // Not a release tag of this scheme: ignore.
    }
  }
  const out = [];
  for (const group of groupsOf(current)) {
    const higher = others.some(
      (o) => groupsOf(o).includes(group) && compareVersions(o, current) > 0,
    );
    if (higher) continue;
    out.push(group);
    if (group === 'latest') out.push('stable');
  }
  return out;
}

function gitVersions() {
  const out = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((t) => t.replace(/^v/, ''));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const version = args[0]?.replace(/^v/, '');
  if (!version || version.startsWith('-')) {
    console.error('usage: channel-tags.mjs <version> [--tags v1.0.0,v1.1.0]');
    process.exit(2);
  }
  try {
    const i = args.indexOf('--tags');
    const versions =
      i >= 0
        ? (args[i + 1] ?? '')
            .split(',')
            .filter(Boolean)
            .map((t) => t.replace(/^v/, ''))
        : gitVersions();
    for (const tag of movingTags(version, versions)) console.log(tag);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
