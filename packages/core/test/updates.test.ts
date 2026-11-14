import { describe, expect, it, vi } from 'vitest';
// The release scripts are plain ESM without types.
// @ts-expect-error no declaration file for the .mjs script
import { movingTags } from '../../../scripts/release/channel-tags.mjs';

const general = {
  updateCheckEnabled: true,
  updateRepository: '',
};
vi.mock('../src/settings', () => ({ getSetting: async () => general }));

import {
  compareReleaseVersions,
  detectComposeDrift,
  effectiveUpdateRepository,
  fetchReleases,
  getUpdateStatus,
  newestForChannel,
  parseChannel,
  parseReleaseVersion,
  type ParsedVersion,
} from '../src/updates';

const v = (raw: string) => parseReleaseVersion(raw)!;

describe('versions and channels', () => {
  it('orders versions like SemVer (alpha < beta < rc < final)', () => {
    const order = [
      '1.0.0-alpha.2',
      '1.0.0-alpha.10',
      '1.0.0-beta.1',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
    ];
    const shuffled = [...order].reverse().map(v);
    expect(shuffled.sort(compareReleaseVersions).map((x) => x.version)).toEqual(order);
    expect(parseReleaseVersion('v1.2.3')?.version).toBe('1.2.3');
    expect(parseReleaseVersion('1.2')).toBeNull();
    expect(parseReleaseVersion('1.0.0-dev.1')).toBeNull();
  });

  it('parses channels', () => {
    expect(parseChannel('')).toEqual({ kind: 'stable' });
    expect(parseChannel(undefined)).toEqual({ kind: 'stable' });
    expect(parseChannel('latest')).toEqual({ kind: 'stable' });
    expect(parseChannel('next')).toEqual({ kind: 'next' });
    expect(parseChannel('rc')).toEqual({ kind: 'stage', stage: 'rc' });
    expect(parseChannel('1')).toEqual({ kind: 'line', major: 1, minor: null });
    expect(parseChannel('1.4')).toEqual({ kind: 'line', major: 1, minor: 4 });
    expect(parseChannel('1.0.0-alpha.2')).toMatchObject({ kind: 'exact' });
    expect(parseChannel('bogus')).toBeNull();
  });

  it('picks the same release as the moving image tags of channel-tags.mjs', () => {
    const all = [
      '1.0.0-alpha.1',
      '1.0.0-alpha.20',
      '1.0.0-beta.2',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0-alpha.1',
      '1.1.0',
      '2.0.0-alpha.1',
      '1.0.2', // an older line published last
    ];
    const parsed = all.map(v);
    const channels: [string, string][] = [
      ['next', 'next'],
      ['stable', 'latest'],
      ['alpha', 'alpha'],
      ['beta', 'beta'],
      ['rc', 'rc'],
      ['1', '1'],
      ['1.0', '1.0'],
      ['1.1', '1.1'],
      ['2', '2'],
    ];
    for (const [channel, tag] of channels) {
      const spec = parseChannel(channel)!;
      const mine = newestForChannel(parsed, spec)?.version ?? null;
      // The release that owns the moving tag is the one for which movingTags() contains it.
      const owners = all.filter((version) => (movingTags(version, all) as string[]).includes(tag));
      expect(owners, `channel ${channel}`).toEqual(mine === null ? [] : [mine]);
    }
  });

  it('exact pins look at the newest release of their kind', () => {
    const all: ParsedVersion[] = ['1.0.0-alpha.3', '1.0.0-alpha.4', '1.0.0', '1.0.1'].map(v);
    expect(newestForChannel(all, parseChannel('1.0.0')!)?.version).toBe('1.0.1');
    expect(newestForChannel(all, parseChannel('1.0.0-alpha.3')!)?.version).toBe('1.0.1');
    expect(newestForChannel(all.slice(0, 2), parseChannel('1.0.0')!)).toBeNull();
  });
});

describe('fetchReleases', () => {
  const json = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('keeps published releases of the scheme and ignores drafts and foreign tags', async () => {
    const releases = await fetchReleases('owner/repo', {
      fetchImpl: json([
        {
          tag_name: 'v1.2.0',
          html_url: 'https://github.com/owner/repo/releases/tag/v1.2.0',
          published_at: '2026-11-01T00:00:00Z',
        },
        { tag_name: 'v1.3.0-rc.1', html_url: 'https://evil.example/x', draft: false },
        { tag_name: 'v9.9.9', draft: true },
        { tag_name: 'nightly' },
      ]),
    });
    expect(releases.map((r) => r.version)).toEqual(['1.2.0', '1.3.0-rc.1']);
    expect(releases[1]).toMatchObject({
      prerelease: true,
      url: 'https://github.com/owner/repo/releases/tag/v1.3.0-rc.1',
    });
  });

  it('only calls api.github.com, never follows redirects, and rejects bad answers', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    await fetchReleases('owner/repo', {
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response('[]');
      }) as unknown as typeof fetch,
    });
    expect(calls[0]!.url).toBe('https://api.github.com/repos/owner/repo/releases?per_page=50');
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(JSON.stringify(calls[0]!.init?.headers)).not.toMatch(/authorization|cookie/i);
    await expect(fetchReleases('owner/../x', { fetchImpl: json([]) })).rejects.toThrow();
    await expect(
      fetchReleases('owner/repo', {
        fetchImpl: (async () =>
          new Response(null, {
            status: 301,
            headers: { location: 'https://api.github.com/repositories/1' },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/has moved/);
    await expect(
      fetchReleases('owner/repo', {
        fetchImpl: (async () =>
          new Response('[]', {
            headers: { 'content-length': '5000000' },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/too large/);
    // Streamed without a content-length header: aborted once the limit is exceeded.
    await expect(
      fetchReleases('owner/repo', {
        fetchImpl: (async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                c.enqueue(new Uint8Array(500_000));
              },
            }),
          )) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/too large/);
    await expect(fetchReleases('owner/repo', { fetchImpl: json({}, 500) })).rejects.toThrow(
      /HTTP 500/,
    );
    await expect(
      fetchReleases('owner/repo', { fetchImpl: json({ message: 'x' }) }),
    ).rejects.toThrow();
  });
});

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, value: string, ...args: (string | number)[]) => {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, value);
      return 'OK';
    },
  };
}

describe('getUpdateStatus', () => {
  const release = (version: string) => ({
    tag_name: `v${version}`,
    html_url: `https://github.com/owner/repo/releases/tag/v${version}`,
  });
  const setup = (releases: unknown, status = 200) => {
    const redis = fakeRedis();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(releases), { status }),
    ) as unknown as typeof fetch;
    const ctx = { db: {}, redis, keys: { prefix: 't' } } as never;
    return { redis, fetchImpl, ctx };
  };
  const input = (fetchImpl: typeof fetch, extra: object = {}) => ({
    channel: 'next',
    currentVersion: '1.0.0-alpha.20',
    defaultRepository: 'owner/repo',
    fetchImpl,
    ...extra,
  });

  it('answers immediately (pending), refreshes in the background and caches for 6 hours', async () => {
    const { ctx, fetchImpl, redis } = setup([release('1.0.0-alpha.21'), release('1.0.0-alpha.20')]);
    const first = await getUpdateStatus(ctx, input(fetchImpl));
    expect(first.status).toBe('pending');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const second = await vi.waitFor(async () => {
      const s = await getUpdateStatus(ctx, input(fetchImpl));
      expect(s.status).toBe('ok');
      return s;
    });
    expect(second).toMatchObject({ updateAvailable: true, latest: { version: '1.0.0-alpha.21' } });
    await getUpdateStatus(ctx, input(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Stale after 6 h: served from the cache while a new fetch starts (the 60 s lock has expired).
    redis.store.delete('t:updates:lock');
    const later = await getUpdateStatus(ctx, input(fetchImpl, { now: Date.now() + 7 * 3_600_000 }));
    expect(later.status).toBe('ok');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });

  it('respects channels, pins and a newer running version', async () => {
    const { ctx, fetchImpl } = setup([release('1.0.0-alpha.21'), release('1.0.0')]);
    const stable = await getUpdateStatus(
      ctx,
      input(fetchImpl, { channel: 'stable', waitForRefresh: true }),
    );
    expect(stable).toMatchObject({ updateAvailable: true, latest: { version: '1.0.0' } });
    const alpha = await getUpdateStatus(ctx, input(fetchImpl, { channel: 'alpha' }));
    expect(alpha).toMatchObject({ updateAvailable: true, latest: { version: '1.0.0-alpha.21' } });
    const pinned = await getUpdateStatus(ctx, input(fetchImpl, { channel: '1.0.0-alpha.20' }));
    expect(pinned).toMatchObject({
      pinned: true,
      updateAvailable: false,
      latest: { version: '1.0.0' },
    });
    const ahead = await getUpdateStatus(ctx, input(fetchImpl, { currentVersion: '2.0.0' }));
    expect(ahead.updateAvailable).toBe(false);
  });

  it('fails silently: an error is reported without throwing and a failure keeps the last good result', async () => {
    const { ctx, redis } = setup([]);
    const failing = vi.fn(
      async () => new Response('x', { status: 503 }),
    ) as unknown as typeof fetch;
    const status = await getUpdateStatus(ctx, input(failing, { waitForRefresh: true }));
    expect(status).toMatchObject({ status: 'error', checkFailed: true, updateAvailable: false });
    // A later failure after a success keeps showing the earlier result.
    redis.store.clear();
    const ok = vi.fn(
      async () => new Response(JSON.stringify([release('1.0.0-alpha.22')])),
    ) as unknown as typeof fetch;
    await getUpdateStatus(ctx, input(ok, { waitForRefresh: true }));
    redis.store.delete('t:updates:lock');
    await getUpdateStatus(
      ctx,
      input(failing, { waitForRefresh: true, now: Date.now() + 7 * 3_600_000 }),
    );
    redis.store.delete('t:updates:lock');
    const kept = await getUpdateStatus(ctx, input(failing, { now: Date.now() + 8 * 3_600_000 }));
    expect(kept).toMatchObject({
      status: 'ok',
      checkFailed: true,
      latest: { version: '1.0.0-alpha.22' },
    });
  });

  it('does nothing when switched off or without a repository', async () => {
    const { ctx, fetchImpl } = setup([]);
    general.updateCheckEnabled = false;
    expect((await getUpdateStatus(ctx, input(fetchImpl))).status).toBe('disabled');
    general.updateCheckEnabled = true;
    expect((await getUpdateStatus(ctx, input(fetchImpl, { defaultRepository: '' }))).status).toBe(
      'unconfigured',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    general.updateRepository = 'other/repo';
    await getUpdateStatus(ctx, input(fetchImpl, { waitForRefresh: true }));
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      '/repos/other/repo/',
    );
    general.updateRepository = '';
  });
});

describe('compose drift', () => {
  it('warns only for a release compose file of another version', () => {
    const base = { appVersion: '1.0.0-alpha.21', repository: 'owner/repo' };
    expect(detectComposeDrift({ ...base, composeVersion: undefined })).toBeNull();
    expect(detectComposeDrift({ ...base, composeVersion: '' })).toBeNull();
    expect(detectComposeDrift({ ...base, composeVersion: 'dev' })).toBeNull();
    expect(detectComposeDrift({ ...base, composeVersion: '__TIX_VERSION__' })).toBeNull();
    expect(detectComposeDrift({ ...base, appVersion: 'dev', composeVersion: '1.0.0' })).toBeNull();
    expect(detectComposeDrift({ ...base, composeVersion: '1.0.0-alpha.21' })).toBeNull();
    expect(detectComposeDrift({ ...base, composeVersion: '1.0.0-alpha.20' })).toEqual({
      composeVersion: '1.0.0-alpha.20',
      appVersion: '1.0.0-alpha.21',
      downloadUrl:
        'https://github.com/owner/repo/releases/download/v1.0.0-alpha.21/docker-compose.yml',
    });
    expect(
      detectComposeDrift({ ...base, repository: null, composeVersion: '1.0.0-alpha.20' })
        ?.downloadUrl,
    ).toBeNull();
  });

  it('resolves the repository from the setting first', () => {
    expect(effectiveUpdateRepository('a/b', 'c/d')).toBe('a/b');
    expect(effectiveUpdateRepository('', 'c/d')).toBe('c/d');
    expect(effectiveUpdateRepository('', '')).toBeNull();
    expect(effectiveUpdateRepository('not a repo', '')).toBeNull();
  });
});
