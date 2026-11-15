import { describe, expect, it } from 'vitest';
import { createKeyspace, type Redis } from '@tix/redis';
import { generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import {
  REENCRYPT_FOLLOW_UP_ATTEMPTS,
  REENCRYPT_FOLLOW_UP_RETRY_MS,
  countBackupsUsingKeys,
  enqueueReEncrypt,
  getReEncryptPending,
  secretKeyEntry,
  secretKeysMissingFrom,
  shouldRetryBusyReEncrypt,
  type CoreContext,
} from '../src';

function fakeCtx(options: { failAdd?: boolean } = {}) {
  const store = new Map<string, string>();
  const added: { queue: string; name: string; data: unknown; opts: Record<string, unknown> }[] = [];
  const redis = {
    set: async (k: string, v: string) => (store.set(k, v), 'OK'),
    get: async (k: string) => store.get(k) ?? null,
    del: async (...ks: string[]) => ks.filter((k) => store.delete(k)).length,
  } as unknown as Redis;
  const jobs = {
    add: async (queue: string, name: string, data: unknown, opts: Record<string, unknown>) => {
      if (options.failAdd) throw new Error('queue down');
      added.push({ queue, name, data, opts });
    },
  };
  return { ctx: { redis, keys: createKeyspace('t'), jobs } as unknown as CoreContext, added };
}

describe('re-encryption queued by a restore', () => {
  it('is queued with a delay and leaves a pending notice', async () => {
    const { ctx, added } = fakeCtx();
    await enqueueReEncrypt(ctx, 'u1', 'RESTORE', 5_000);
    expect(added).toHaveLength(1);
    expect(added[0]!.opts).toMatchObject({ delay: 5_000 });
    // about ten minutes of retries
    expect(REENCRYPT_FOLLOW_UP_ATTEMPTS * REENCRYPT_FOLLOW_UP_RETRY_MS).toBeGreaterThanOrEqual(
      9 * 60_000,
    );
    expect(await getReEncryptPending(ctx)).toMatchObject({ since: expect.any(String) });
  });

  it('a manual request stays a single attempt and sets no pending notice', async () => {
    const { ctx, added } = fakeCtx();
    await enqueueReEncrypt(ctx, 'u1', 'MANUAL');
    expect(added[0]!.opts).toMatchObject({ attempts: 1 });
    expect(await getReEncryptPending(ctx)).toBeNull();
  });

  it('removes the pending notice again when the job cannot be queued', async () => {
    const { ctx } = fakeCtx({ failAdd: true });
    await expect(enqueueReEncrypt(ctx, 'u1', 'RESTORE')).rejects.toThrow('queue down');
    expect(await getReEncryptPending(ctx)).toBeNull();
  });

  it('waits for a busy lock only for the restore follow-up and only a bounded number of times', () => {
    expect(shouldRetryBusyReEncrypt('RESTORE', 0)).toBe(true);
    expect(shouldRetryBusyReEncrypt('RESTORE', REENCRYPT_FOLLOW_UP_ATTEMPTS - 1)).toBe(true);
    expect(shouldRetryBusyReEncrypt('RESTORE', REENCRYPT_FOLLOW_UP_ATTEMPTS)).toBe(false);
    expect(shouldRetryBusyReEncrypt('MANUAL', 0)).toBe(false);
    expect(shouldRetryBusyReEncrypt(undefined, 0)).toBe(false);
  });
});

describe('secret key references in backup manifests', () => {
  const [a] = parseKeyRing(generateKeyRingEntry('k1'));
  const [b] = parseKeyRing(generateKeyRingEntry('k1')); // same id, other material
  const manifestA = { secretKeys: [secretKeyEntry(a!), 'zz:unreadable'] };

  it('tells equal ids with different material apart', () => {
    expect(secretKeyEntry(a!)).not.toBe(secretKeyEntry(b!));
    expect(secretKeysMissingFrom(manifestA, [b!])).toEqual([secretKeyEntry(a!)]);
    expect(secretKeysMissingFrom(manifestA, [b!, a!])).toEqual([]);
    // entries that were unreadable at backup time are not "missing keys"
    expect(secretKeysMissingFrom({ secretKeys: ['zz:unreadable'] }, [])).toEqual([]);
    // old manifests have no list
    expect(secretKeysMissingFrom({}, [])).toEqual([]);
  });

  it('counts the backups that reference the keys about to be removed', () => {
    const manifests = [manifestA, { secretKeys: [secretKeyEntry(b!)] }, {}];
    expect(countBackupsUsingKeys(manifests, [a!])).toBe(1);
    expect(countBackupsUsingKeys(manifests, [a!, b!])).toBe(2);
    expect(countBackupsUsingKeys(manifests, [])).toBe(0);
  });
});
