import { describe, expect, it, vi } from 'vitest';
import {
  isMountPointIn,
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
