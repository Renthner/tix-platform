import { isValidGithubRepository } from '@tix/shared';
import type { CoreContext } from './context';
import { getSetting } from './settings';

/**
 * Update notice and docker-compose drift for the admin dashboard.
 *
 * Releases are read from the GitHub Releases API of the configured repository, server-side, at
 * most every 6 hours (Redis cache shared by all instances, a short lock so only one instance
 * fetches). Reading never waits for the network: a stale or missing cache answers immediately
 * and a background refresh updates it for the next page view. Nothing about the installation is
 * sent (only a generic User-Agent). The channel semantics mirror scripts/release/channel-tags.mjs
 * (parity test in packages/core/test/updates.test.ts).
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;
const STAGE_ORDER = { alpha: 0, beta: 1, rc: 2 } as const;

export interface ParsedVersion {
  version: string;
  major: number;
  minor: number;
  patch: number;
  stage: 'alpha' | 'beta' | 'rc' | null;
  n: number;
}

export function parseReleaseVersion(raw: string): ParsedVersion | null {
  const version = raw.replace(/^v/, '');
  const m = SEMVER.exec(version);
  if (!m) return null;
  return {
    version,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    stage: (m[4] as ParsedVersion['stage']) ?? null,
    n: m[5] === undefined ? 0 : Number(m[5]),
  };
}

/** SemVer precedence limited to the release scheme (alpha < beta < rc < final). */
export function compareReleaseVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if ((a.stage === null) !== (b.stage === null)) return a.stage === null ? 1 : -1;
  if (a.stage === null || b.stage === null) return 0;
  if (a.stage !== b.stage) return STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
  return a.n - b.n;
}

export type ChannelSpec =
  | { kind: 'next' }
  | { kind: 'stable' }
  | { kind: 'stage'; stage: 'alpha' | 'beta' | 'rc' }
  | { kind: 'line'; major: number; minor: number | null }
  | { kind: 'exact'; version: ParsedVersion };

/** `TIX_CHANNEL` value (empty = stable). Null when it is not a known channel or version. */
export function parseChannel(raw: string | undefined): ChannelSpec | null {
  const value = (raw ?? '').trim().replace(/^v/, '');
  if (value === '' || value === 'stable' || value === 'latest') return { kind: 'stable' };
  if (value === 'next') return { kind: 'next' };
  if (value === 'alpha' || value === 'beta' || value === 'rc') {
    return { kind: 'stage', stage: value };
  }
  const exact = parseReleaseVersion(value);
  if (exact) return { kind: 'exact', version: exact };
  const line = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (line)
    return { kind: 'line', major: Number(line[1]), minor: line[2] ? Number(line[2]) : null };
  return null;
}

function newest(versions: readonly ParsedVersion[]): ParsedVersion | null {
  let best: ParsedVersion | null = null;
  for (const v of versions) if (!best || compareReleaseVersions(v, best) > 0) best = v;
  return best;
}

/** The release a moving channel tag points at (highest SemVer of its group; exact pins: of their kind). */
export function newestForChannel(
  versions: readonly ParsedVersion[],
  spec: ChannelSpec,
): ParsedVersion | null {
  switch (spec.kind) {
    case 'next':
      return newest(versions);
    case 'stable':
      return newest(versions.filter((v) => v.stage === null));
    case 'stage':
      return newest(versions.filter((v) => v.stage === spec.stage));
    case 'line':
      return newest(
        versions.filter(
          (v) =>
            v.stage === null &&
            v.major === spec.major &&
            (spec.minor === null || v.minor === spec.minor),
        ),
      );
    case 'exact':
      return newest(
        versions.filter((v) => (spec.version.stage === null ? v.stage === null : true)),
      );
  }
}

// ─── GitHub Releases ──────────────────────────────────────────────────────────

export interface ReleaseInfo {
  version: string;
  prerelease: boolean;
  url: string;
  publishedAt: string | null;
}

const MAX_RESPONSE_BYTES = 2_000_000;

/** Response text, aborting while streaming as soon as more than `limit` bytes arrive. */
async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('GitHub response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchReleases(
  repository: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReleaseInfo[]> {
  if (!isValidGithubRepository(repository)) throw new Error('Invalid repository');
  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch(`https://api.github.com/repos/${repository}/releases?per_page=50`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tix-platform-update-check',
    },
    // Never followed (the request must only ever reach api.github.com); a 301 means the repository
    // was renamed or transferred, which is worth a clear message.
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  if (res.status === 301 || res.status === 308) {
    throw new Error(
      'The repository has moved (GitHub answered HTTP 301): set the new owner/name in Settings -> General -> Updates',
    );
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`GitHub answered an unexpected redirect (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error('GitHub response too large');
  const body: unknown = JSON.parse(await readLimited(res, MAX_RESPONSE_BYTES));
  if (!Array.isArray(body)) throw new Error('Unexpected GitHub response');
  const out: ReleaseInfo[] = [];
  for (const item of body as Record<string, unknown>[]) {
    if (!item || item.draft === true || typeof item.tag_name !== 'string') continue;
    const parsed = parseReleaseVersion(item.tag_name);
    if (!parsed || !item.tag_name.startsWith('v')) continue;
    const url =
      typeof item.html_url === 'string' && item.html_url.startsWith('https://github.com/')
        ? item.html_url
        : `https://github.com/${repository}/releases/tag/${item.tag_name}`;
    out.push({
      version: parsed.version,
      prerelease: parsed.stage !== null,
      url,
      publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
    });
  }
  return out;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface UpdateStatus {
  /** disabled: switched off; unconfigured: no repository; pending: nothing fetched yet; error: last fetch failed and nothing cached. */
  status: 'disabled' | 'unconfigured' | 'pending' | 'error' | 'ok';
  channel: string;
  current: string;
  repository: string | null;
  /** The newest release of the channel (exact pins: of their kind). */
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  /** TIX_CHANNEL is an exact version: informational only. */
  pinned: boolean;
  /** The last refresh failed (an older result may still be shown). */
  checkFailed: boolean;
  checkedAt: string | null;
}

interface CachedReleases {
  repository: string;
  fetchedAt: number;
  releases: ReleaseInfo[] | null;
  error: string | null;
  /** Last successful result kept across failures. */
  lastGood: { fetchedAt: number; releases: ReleaseInfo[] } | null;
}

export const UPDATE_CHECK_INTERVAL_MS = 6 * 3_600_000;
const ERROR_RETRY_MS = 30 * 60_000;
const CACHE_TTL_SECONDS = 14 * 86_400;
const LOCK_SECONDS = 60;

function redisKeys(ctx: Pick<CoreContext, 'keys'>) {
  const base = `${ctx.keys.prefix}:updates`;
  return { cache: `${base}:releases`, lock: `${base}:lock` };
}

async function refresh(
  ctx: Pick<CoreContext, 'redis' | 'keys'>,
  repository: string,
  previous: CachedReleases | null,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const keys = redisKeys(ctx);
  const sameRepo = previous && previous.repository === repository ? previous : null;
  let next: CachedReleases;
  try {
    const releases = await fetchReleases(repository, { fetchImpl });
    next = {
      repository,
      fetchedAt: Date.now(),
      releases,
      error: null,
      lastGood: { fetchedAt: Date.now(), releases },
    };
  } catch (err) {
    next = {
      repository,
      fetchedAt: Date.now(),
      releases: null,
      error: err instanceof Error ? err.message.slice(0, 200) : 'error',
      lastGood: sameRepo?.lastGood ?? null,
    };
  }
  await ctx.redis.set(keys.cache, JSON.stringify(next), 'EX', CACHE_TTL_SECONDS);
}

async function readCache(ctx: Pick<CoreContext, 'redis' | 'keys'>): Promise<CachedReleases | null> {
  try {
    const raw = await ctx.redis.get(redisKeys(ctx).cache);
    return raw ? (JSON.parse(raw) as CachedReleases) : null;
  } catch {
    return null;
  }
}

/** Repository for the update check and the compose download link: the setting, else the build-time default. */
export function effectiveUpdateRepository(
  setting: string | undefined,
  defaultRepository: string,
): string | null {
  const value = (setting ?? '').trim() || defaultRepository.trim();
  return value && isValidGithubRepository(value) ? value : null;
}

export interface UpdateStatusInput {
  /** `TIX_CHANNEL` of the installation. */
  channel: string;
  /** Running version (APP_VERSION). */
  currentVersion: string;
  /** Repository this release was built from (`TIX_UPDATE_REPOSITORY`); used when the setting is empty. */
  defaultRepository: string;
  /** Await the refresh instead of running it in the background (tests, CLIs). */
  waitForRefresh?: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function getUpdateStatus(
  ctx: Pick<CoreContext, 'db' | 'redis' | 'keys'>,
  input: UpdateStatusInput,
): Promise<UpdateStatus> {
  const base: UpdateStatus = {
    status: 'pending',
    channel: input.channel || 'stable',
    current: input.currentVersion,
    repository: null,
    latest: null,
    updateAvailable: false,
    pinned: false,
    checkFailed: false,
    checkedAt: null,
  };
  const general = await getSetting(ctx, 'general');
  if (!general.updateCheckEnabled) return { ...base, status: 'disabled' };
  const repository = general.updateRepository || input.defaultRepository.trim();
  if (!repository || !isValidGithubRepository(repository)) {
    return { ...base, status: 'unconfigured' };
  }
  const spec = parseChannel(input.channel);
  const status: UpdateStatus = { ...base, repository, pinned: spec?.kind === 'exact' };

  const now = input.now ?? Date.now();
  let cached = await readCache(ctx);
  if (cached && cached.repository !== repository) cached = null;
  const fresh =
    cached !== null &&
    now - cached.fetchedAt < (cached.error === null ? UPDATE_CHECK_INTERVAL_MS : ERROR_RETRY_MS);
  if (!fresh) {
    // One instance refreshes; the others keep answering from the cache.
    let acquired = false;
    try {
      acquired = (await ctx.redis.set(redisKeys(ctx).lock, '1', 'EX', LOCK_SECONDS, 'NX')) === 'OK';
    } catch {
      acquired = false;
    }
    if (acquired) {
      const job = refresh(ctx, repository, cached, input.fetchImpl).catch(() => undefined);
      if (input.waitForRefresh) {
        await job;
        cached = await readCache(ctx);
      }
    }
  }
  if (!cached) return status;

  const releases = cached.releases ?? cached.lastGood?.releases ?? null;
  const fetchedAt = cached.releases ? cached.fetchedAt : (cached.lastGood?.fetchedAt ?? null);
  if (!releases) return { ...status, status: 'error', checkFailed: true };
  const parsed = releases
    .map((r) => ({ release: r, version: parseReleaseVersion(r.version) }))
    .filter((r): r is { release: ReleaseInfo; version: ParsedVersion } => r.version !== null);
  const target = spec
    ? newestForChannel(
        parsed.map((p) => p.version),
        spec,
      )
    : null;
  const latest = target
    ? (parsed.find((p) => p.version.version === target.version)?.release ?? null)
    : null;
  const current = parseReleaseVersion(input.currentVersion);
  const newer = Boolean(target && current && compareReleaseVersions(target, current) > 0);
  return {
    ...status,
    status: 'ok',
    latest,
    updateAvailable: newer && !status.pinned,
    checkFailed: cached.error !== null,
    checkedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
  };
}

// ─── docker-compose.yml drift ─────────────────────────────────────────────────

export interface ComposeDrift {
  composeVersion: string;
  appVersion: string;
  /** Direct download of the docker-compose.yml that belongs to the running version (null: repository unknown). */
  downloadUrl: string | null;
}

/**
 * The release compose file carries its own version (`TIX_COMPOSE_VERSION`); the dev compose says
 * `dev` and an unset value (older compose files) means "unknown": neither warns.
 */
export function detectComposeDrift(input: {
  composeVersion: string | undefined;
  appVersion: string;
  repository: string | null;
}): ComposeDrift | null {
  const composeVersion = (input.composeVersion ?? '').trim();
  // Only real release versions count: '', 'dev' and an unreplaced '__TIX_VERSION__' placeholder
  // (a hand-edited or dev build) never warn.
  if (!parseReleaseVersion(composeVersion) || !parseReleaseVersion(input.appVersion)) return null;
  if (composeVersion === input.appVersion) return null;
  return {
    composeVersion,
    appVersion: input.appVersion,
    downloadUrl:
      input.repository && isValidGithubRepository(input.repository)
        ? `https://github.com/${input.repository}/releases/download/v${input.appVersion}/docker-compose.yml`
        : null,
  };
}
