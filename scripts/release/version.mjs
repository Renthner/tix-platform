// Shared helpers for the release scripts: SemVer parsing and the Android versionCode.
//
// versionCode = MAJOR*1_000_000 + MINOR*10_000 + PATCH*100 + stage
//   alpha.N -> N (1-29)   beta.N -> 30+N (N 1-29)   rc.N -> 60+N (N 1-29)   final -> 99
// MINOR and PATCH <= 99 keep the fields from overlapping; MAJOR <= 2000 keeps the result below
// Android's 2_100_000_000 limit.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;
const STAGE_BASE = { alpha: 0, beta: 30, rc: 60 };

export function parseVersion(version) {
  const m = SEMVER.exec(version);
  if (!m) {
    throw new Error(
      `Invalid version "${version}": expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-(alpha|beta|rc).N`,
    );
  }
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  if (major > 2000) throw new Error(`MAJOR must be <= 2000 (got ${major})`);
  if (minor > 99) throw new Error(`MINOR must be <= 99 (got ${minor})`);
  if (patch > 99) throw new Error(`PATCH must be <= 99 (got ${patch})`);
  const tag = m[4] ?? null;
  const n = m[5] === undefined ? null : Number(m[5]);
  if (tag && (n < 1 || n > 29)) throw new Error(`${tag}.N: N must be between 1 and 29 (got ${n})`);
  return { major, minor, patch, tag, n, prerelease: tag !== null };
}

export function versionCode(version) {
  const v = parseVersion(version);
  const stage = v.tag ? STAGE_BASE[v.tag] + v.n : 99;
  return v.major * 1_000_000 + v.minor * 10_000 + v.patch * 100 + stage;
}
