import { describe, expect, it, vi } from 'vitest';
import {
  isMountPointIn,
  isOnPersistentVolumeIn,
  runPreUpdatePolicy,
  type PreUpdateBackupResult,
} from '../src/backup/pre-update';

const result: PreUpdateBackupResult = {
  id: 'x',
  location: 'local',
  path: '/p/x.tixbak',
  sizeBytes: 1,
};
const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const bucket = () => ({ destroy: vi.fn() }) as never;

describe('isMountPointIn', () => {
  const info = [
    '36 35 98:0 / / rw - overlay overlay rw',
    '40 36 8:1 /var/lib/docker/volumes/x /pre-update-backups rw,relatime - ext4 /dev/sda1 rw',
    '41 36 8:1 /y /with\\040space rw - ext4 /dev/sda1 rw',
  ].join('\n');
  it('finds real mounts only', () => {
    expect(isMountPointIn(info, '/pre-update-backups')).toBe(true);
    expect(isMountPointIn(info, '/pre-update-backups/')).toBe(true);
    expect(isMountPointIn(info, '/with space')).toBe(true);
    expect(isMountPointIn(info, '/pre-update')).toBe(false);
    expect(isMountPointIn(info, '/tmp')).toBe(false);
  });
});

describe('isOnPersistentVolumeIn', () => {
  const container = [
    '36 35 98:0 / / rw - overlay overlay rw',
    '37 36 0:5 / /proc rw - proc proc rw',
    '38 36 0:6 / /dev rw - tmpfs tmpfs rw',
    '40 36 8:1 /var/lib/docker/volumes/x /data rw,relatime - ext4 /dev/sda1 rw',
    '41 36 0:50 / /run/shm rw - tmpfs tmpfs rw',
  ].join('\n');
  it('accepts a path inside a mounted volume (storage directory below the mount point)', () => {
    expect(isOnPersistentVolumeIn(container, '/data')).toBe(true);
    expect(isOnPersistentVolumeIn(container, '/data/storage/backups')).toBe(true);
    expect(isOnPersistentVolumeIn(container, '/data/storage/backups/')).toBe(true);
  });
  it('rejects the container layer and memory file systems', () => {
    expect(isOnPersistentVolumeIn(container, '/data2/storage')).toBe(false); // component match only
    expect(isOnPersistentVolumeIn(container, '/app/storage')).toBe(false);
    expect(isOnPersistentVolumeIn(container, '/tmp/x')).toBe(false);
    expect(isOnPersistentVolumeIn(container, '/dev/shm/x')).toBe(false); // tmpfs
    expect(isOnPersistentVolumeIn(container, '/run/shm/x')).toBe(false); // tmpfs
  });
  it('treats everything as persistent when the root is not a container layer', () => {
    const host = [
      '26 1 8:1 / / rw - ext4 /dev/sda1 rw',
      '27 26 0:5 / /proc rw - proc proc rw',
    ].join('\n');
    expect(isOnPersistentVolumeIn(host, '/srv/tix/storage')).toBe(true);
  });
});

describe('runPreUpdatePolicy', () => {
  it('old compose (no version), no credentials, no mount: warns and continues', async () => {
    const log = logger();
    const create = vi.fn();
    const out = await runPreUpdatePolicy({
      skip: false,
      composeVersion: undefined,
      makeBucket: () => {
        throw new Error('S3_ACCESS_KEY_ID_FILE: cannot read /run/tix-storage/x');
      },
      localDir: '/pre-update-backups',
      isMountPoint: async () => false,
      create,
      logger: log,
    });
    expect(out).toEqual({ kind: 'skipped', reason: 'old-compose' });
    expect(create).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/older release/);
  });

  it('old compose with a bucket whose backup fails: warns, continues, destroys the bucket', async () => {
    const b = bucket();
    const log = logger();
    const out = await runPreUpdatePolicy({
      skip: false,
      composeVersion: '',
      makeBucket: () => b,
      localDir: '/pre-update-backups',
      isMountPoint: async () => false,
      create: async () => {
        throw new Error('connect ECONNREFUSED minio:9000');
      },
      logger: log,
    });
    expect(out).toEqual({ kind: 'skipped', reason: 'old-compose' });
    expect((b as unknown as { destroy: () => void }).destroy).toHaveBeenCalled();
    expect(log.warn.mock.calls.map((c) => c[0]).join(' ')).toMatch(/ECONNREFUSED/);
  });

  it('new compose without any target aborts', async () => {
    await expect(
      runPreUpdatePolicy({
        skip: false,
        composeVersion: '1.0.0',
        makeBucket: () => null,
        localDir: '/pre-update-backups',
        isMountPoint: async () => false,
        create: vi.fn(),
        logger: logger(),
      }),
    ).rejects.toThrow(/No place to store/);
  });

  it('new compose: a failing backup propagates', async () => {
    await expect(
      runPreUpdatePolicy({
        skip: false,
        composeVersion: '1.0.0',
        makeBucket: () => null,
        localDir: '/d',
        isMountPoint: async () => true,
        create: async () => {
          throw new Error('pg_dump failed');
        },
        logger: logger(),
      }),
    ).rejects.toThrow('pg_dump failed');
  });

  it('uses a mounted local dir and destroys the bucket', async () => {
    const b = bucket();
    const create = vi.fn(async () => result);
    const out = await runPreUpdatePolicy({
      skip: false,
      composeVersion: '1.0.0',
      makeBucket: () => b,
      localDir: '/d',
      isMountPoint: async () => true,
      create,
      logger: logger(),
    });
    expect(out.kind).toBe('created');
    expect(create).toHaveBeenCalledWith({ bucket: b, localDir: '/d' });
    expect((b as unknown as { destroy: () => void }).destroy).toHaveBeenCalled();
  });

  it('never uses an unmounted directory', async () => {
    const create = vi.fn(async (_t: { bucket: unknown; localDir: string | null }) => result);
    await runPreUpdatePolicy({
      skip: false,
      composeVersion: '1.0.0',
      makeBucket: bucket,
      localDir: '/d',
      isMountPoint: async () => false,
      create,
      logger: logger(),
    });
    expect(create.mock.calls[0]![0].localDir).toBeNull();
  });

  describe('filesystem backups bucket', () => {
    const fsBucket = (): never =>
      ({ localPath: '/data/storage/backups', destroy: vi.fn() }) as never;
    const base = {
      skip: false,
      composeVersion: '1.0.0',
      localDir: null,
      isMountPoint: async () => false,
    };

    it('is used (with a same-disk warning) when its directory is inside a volume', async () => {
      const b = fsBucket();
      const log = logger();
      const create = vi.fn(async () => result);
      const isOnVolume = vi.fn(async () => true);
      const out = await runPreUpdatePolicy({
        ...base,
        makeBucket: () => b,
        isOnVolume,
        create,
        logger: log,
      });
      expect(out.kind).toBe('created');
      expect(isOnVolume).toHaveBeenCalledWith('/data/storage/backups');
      expect(create).toHaveBeenCalledWith({ bucket: b, localDir: null });
      expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/same disk/);
    });

    it('counts as no bucket on the container layer: a new compose aborts', async () => {
      const b = fsBucket();
      const create = vi.fn();
      await expect(
        runPreUpdatePolicy({
          ...base,
          makeBucket: () => b,
          isOnVolume: async () => false,
          create,
          logger: logger(),
        }),
      ).rejects.toThrow(/No place to store/);
      expect(create).not.toHaveBeenCalled();
      expect((b as unknown as { destroy: () => void }).destroy).toHaveBeenCalled();
    });

    it('counts as no bucket on the container layer: an old compose skips with a warning', async () => {
      const out = await runPreUpdatePolicy({
        ...base,
        composeVersion: undefined,
        makeBucket: fsBucket,
        isOnVolume: async () => false,
        create: vi.fn(),
        logger: logger(),
      });
      expect(out).toEqual({ kind: 'skipped', reason: 'old-compose' });
    });

    it('falls back to the mounted local directory when the bucket is unusable', async () => {
      const create = vi.fn(async (_t: { bucket: unknown; localDir: string | null }) => result);
      await runPreUpdatePolicy({
        ...base,
        localDir: '/pre-update-backups',
        isMountPoint: async () => true,
        makeBucket: fsBucket,
        isOnVolume: async () => false,
        create,
        logger: logger(),
      });
      expect(create.mock.calls[0]![0]).toEqual({ bucket: null, localDir: '/pre-update-backups' });
    });

    it('an unreadable volume check is not trusted', async () => {
      await expect(
        runPreUpdatePolicy({
          ...base,
          makeBucket: fsBucket,
          isOnVolume: async () => {
            throw new Error('EACCES');
          },
          create: vi.fn(),
          logger: logger(),
        }),
      ).rejects.toThrow(/No place to store/);
    });
  });

  it('honours the opt-out', async () => {
    const out = await runPreUpdatePolicy({
      skip: true,
      composeVersion: '1.0.0',
      makeBucket: () => null,
      localDir: null,
      isMountPoint: async () => false,
      create: vi.fn(),
      logger: logger(),
    });
    expect(out).toEqual({ kind: 'skipped', reason: 'opt-out' });
  });
});
