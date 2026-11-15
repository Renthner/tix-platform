import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BackupBucket } from '../src/backup/bucket';
import { S3Bucket } from '../src/backup/s3';
import { assertSafeObjectKey } from '../src/backup/inspect';
import { FsBucket, FsObjectStorage, sweepStaleTmp, validateStorageKey } from '../src/storage-fs';
import {
  copyBuckets,
  createBackupBuckets,
  createObjectStorage,
  parseStorageEnv,
  storageConfigFromEnv,
} from '../src/storage-config';
import { S3ObjectStorage, type ObjectStorage } from '../src/storage';

/**
 * Contract of the two storage implementations. The filesystem variants always run; the S3 variants
 * only with TEST_S3_OPT_IN=1 and a configured S3 environment (the root .env targets the client
 * stack, so S3 is never touched implicitly). Keys of the S3 runs live below a unique prefix.
 */

const s3Opt = process.env.TEST_S3_OPT_IN === '1' && !!process.env.S3_ENDPOINT;
const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tix-storage-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const chunks = async function* (...parts: (string | Uint8Array)[]) {
  for (const p of parts) yield typeof p === 'string' ? Buffer.from(p) : p;
};

interface BucketVariant {
  name: string;
  make(): Promise<{ bucket: BackupBucket; prefix: string }>;
}

const bucketVariants: BucketVariant[] = [
  {
    name: 'fs',
    make: async () => ({ bucket: new FsBucket(join(await scratch(), 'bucket')), prefix: '' }),
  },
];
if (s3Opt) {
  bucketVariants.push({
    name: 's3',
    make: async () => ({
      bucket: createBackupBuckets(storageConfigFromEnv(process.env)).documents,
      prefix: `tix-test-${randomBytes(6).toString('hex')}/`,
    }),
  });
}

describe.each(bucketVariants)('BackupBucket contract ($name)', (variant) => {
  it('round-trips bytes with the content type', async () => {
    const { bucket, prefix } = await variant.make();
    const key = `${prefix}docs/a.json`;
    await bucket.putBytes(key, '{"a":1}', 'application/json');
    expect((await bucket.getBytes(key)).toString()).toBe('{"a":1}');
    const stream = await bucket.getStream(key);
    expect(stream.contentType).toBe('application/json');
    expect(stream.size).toBe(7);
    const read: Buffer[] = [];
    for await (const c of stream.stream) read.push(Buffer.from(c));
    expect(Buffer.concat(read).toString()).toBe('{"a":1}');
    await bucket.deletePrefix(prefix);
  });

  it('overwrites and keeps the newest content type', async () => {
    const { bucket, prefix } = await variant.make();
    const key = `${prefix}x`;
    await bucket.putBytes(key, 'one', 'text/plain');
    await bucket.putBytes(key, 'two', 'application/pdf');
    expect((await bucket.getBytes(key)).toString()).toBe('two');
    const stream = await bucket.getStream(key);
    expect(stream.contentType).toBe('application/pdf');
    for await (const _ of stream.stream) void _; // consume: closes the file
    await bucket.deletePrefix(prefix);
  });

  it('reports missing keys like S3 (NoSuchKey, 404, tryGetBytes null)', async () => {
    const { bucket, prefix } = await variant.make();
    await expect(bucket.getBytes(`${prefix}missing`)).rejects.toMatchObject({ name: 'NoSuchKey' });
    await expect(bucket.getStream(`${prefix}missing`)).rejects.toMatchObject({
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    expect(await bucket.tryGetBytes(`${prefix}missing`)).toBeNull();
    await bucket.delete(`${prefix}missing`); // no-op
    await bucket.deleteMany([`${prefix}missing-1`, `${prefix}missing-2`]);
  });

  it('lists by plain string prefix in key order and lists directories', async () => {
    const { bucket, prefix } = await variant.make();
    const keys = [
      'backups/20260101-FULL-a/archive.tixbak',
      'backups/20260101-FULL-a/manifest.json',
      'backups/20260102-FULL-b/manifest.json',
      'backups/incoming-1/part',
      'backups/incoming-2/manifest.json',
      'assets/media/x.png',
      'top.txt',
    ].map((k) => prefix + k);
    for (const key of keys) await bucket.putBytes(key, key, 'text/plain');
    const list = async (p: string) => {
      const out: string[] = [];
      for await (const o of bucket.list(prefix + p)) out.push(o.key.slice(prefix.length));
      return out;
    };
    expect(await list('')).toEqual([...keys.map((k) => k.slice(prefix.length))].sort());
    expect(await list('backups/incoming-')).toEqual([
      'backups/incoming-1/part',
      'backups/incoming-2/manifest.json',
    ]);
    expect(await list('backups/20260101-FULL-a/')).toHaveLength(2);
    expect(await list('backups/20260101-FULL-a')).toHaveLength(2); // partial name, no slash
    expect(await list('nothing/')).toEqual([]);
    const sizes: number[] = [];
    for await (const o of bucket.list(prefix + 'top')) {
      sizes.push(o.size);
      expect(o.lastModified).toBeInstanceOf(Date);
    }
    expect(sizes).toEqual([(prefix + 'top.txt').length]);

    expect(
      (await bucket.listDirectories(prefix + 'backups/')).map((d) => d.slice(prefix.length)),
    ).toEqual([
      'backups/20260101-FULL-a/',
      'backups/20260102-FULL-b/',
      'backups/incoming-1/',
      'backups/incoming-2/',
    ]);
    expect(await bucket.listDirectories(prefix + 'top')).toEqual([]);

    // Deleting a "directory" removes it from the listing (no empty directories like in S3).
    expect(await bucket.deletePrefix(prefix + 'backups/incoming-')).toBe(2);
    expect(
      (await bucket.listDirectories(prefix + 'backups/')).map((d) => d.slice(prefix.length)),
    ).toEqual(['backups/20260101-FULL-a/', 'backups/20260102-FULL-b/']);
    await bucket.deleteMany(keys);
    expect(await list('')).toEqual([]);
  });

  it('streams uploads and returns size and SHA-256', async () => {
    const { bucket, prefix } = await variant.make();
    const payload = randomBytes(300_000);
    const written = await bucket.putStream(
      `${prefix}big.bin`,
      chunks(payload.subarray(0, 100_000), payload.subarray(100_000)),
      'application/octet-stream',
    );
    expect(written.sizeBytes).toBe(payload.length);
    expect(written.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect((await bucket.getBytes(`${prefix}big.bin`)).equals(payload)).toBe(true);
    // empty stream = empty object
    expect((await bucket.putStream(`${prefix}empty`, chunks())).sizeBytes).toBe(0);
    expect((await bucket.getBytes(`${prefix}empty`)).length).toBe(0);
    await bucket.deletePrefix(prefix);
  });

  it('an aborted upload leaves nothing behind and keeps the previous object', async () => {
    const { bucket, prefix } = await variant.make();
    await bucket.putBytes(`${prefix}keep`, 'old', 'text/plain');
    const failing = (async function* () {
      yield Buffer.from('partial');
      throw new Error('source failed');
    })();
    await expect(bucket.putStream(`${prefix}keep`, failing)).rejects.toThrow('source failed');
    expect((await bucket.getBytes(`${prefix}keep`)).toString()).toBe('old');
    await expect(
      bucket.putStream(
        `${prefix}new`,
        (async function* () {
          throw new Error('boom');
        })(),
      ),
    ).rejects.toThrow('boom');
    expect(await bucket.tryGetBytes(`${prefix}new`)).toBeNull();
    await bucket.deletePrefix(prefix);
  });

  it('concurrent writes of one key leave one complete value', async () => {
    const { bucket, prefix } = await variant.make();
    const key = `${prefix}race`;
    const values = Array.from({ length: 12 }, (_, i) => Buffer.alloc(50_000, i + 1));
    await Promise.all(
      values.map((v, i) =>
        i % 2 === 0
          ? bucket.putBytes(key, v, 'application/octet-stream')
          : bucket.putStream(key, chunks(v), 'application/octet-stream'),
      ),
    );
    const final = await bucket.getBytes(key);
    expect(final.length).toBe(50_000);
    expect(new Set(final).size).toBe(1); // never a mix of two writers
    await bucket.deletePrefix(prefix);
  });

  it('checkAccess passes on a usable bucket', async () => {
    const { bucket, prefix } = await variant.make();
    await bucket.checkAccess(`${prefix}.tix-probe`);
    expect(await bucket.tryGetBytes(`${prefix}.tix-probe`)).toBeNull();
  });
});

interface StorageVariant {
  name: string;
  make(): Promise<{ storage: ObjectStorage; prefix: string }>;
}
const storageVariants: StorageVariant[] = [
  {
    name: 'fs',
    make: async () => ({ storage: new FsObjectStorage(await scratch()), prefix: '' }),
  },
];
if (s3Opt) {
  storageVariants.push({
    name: 's3',
    make: async () => ({
      storage: createObjectStorage(storageConfigFromEnv(process.env)),
      prefix: `tix-test-${randomBytes(6).toString('hex')}/`,
    }),
  });
}

describe.each(storageVariants)('ObjectStorage contract ($name)', (variant) => {
  it('put / get / getStream / list / delete', async () => {
    const { storage, prefix } = await variant.make();
    const key = `${prefix}media/image/1.png`;
    await storage.put('assets', key, new Uint8Array([1, 2, 3]), 'image/png');
    await storage.put('documents', key, 'doc', 'application/pdf');
    const got = await storage.get('assets', key);
    expect([...got.body]).toEqual([1, 2, 3]);
    expect(got.contentType).toBe('image/png');
    // buckets are separate key spaces
    expect((await storage.get('documents', key)).contentType).toBe('application/pdf');
    const streamed = await storage.getStream('assets', key);
    expect(streamed.contentType).toBe('image/png');
    const read = Buffer.from(await new Response(streamed.stream).arrayBuffer());
    expect([...read]).toEqual([1, 2, 3]);
    expect((await storage.list('assets', `${prefix}media/`)).map((o) => o.key)).toEqual([key]);
    expect((await storage.list('assets', `${prefix}media/`))[0]!.lastModified).toBeInstanceOf(Date);
    await storage.delete('assets', key);
    await storage.delete('assets', key); // idempotent
    await storage.delete('documents', key);
    expect(await storage.list('assets', `${prefix}media/`)).toEqual([]);
  });

  it('missing objects fail with NoSuchKey on get and getStream', async () => {
    const { storage, prefix } = await variant.make();
    await expect(storage.get('assets', `${prefix}nope`)).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
    await expect(storage.getStream('documents', `${prefix}nope`)).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
  });
});

describe('filesystem storage specifics', () => {
  it('rejects keys that could leave the directory', async () => {
    const root = join(await scratch(), 'b');
    const bucket = new FsBucket(root);
    for (const bad of [
      '',
      '/abs',
      '../x',
      'a/../../x',
      'a/./b',
      'a//b',
      'a/',
      'a\\b',
      'c:/x',
      'a\u0000b',
      'trailing.',
      'x'.repeat(1100),
    ]) {
      expect(() => validateStorageKey(bad), JSON.stringify(bad)).toThrow(/Invalid storage key/);
      await expect(bucket.putBytes(bad, 'x', 'text/plain')).rejects.toThrow(/Invalid storage key/);
      await expect(bucket.getBytes(bad)).rejects.toThrow(/Invalid storage key/);
    }
    await expect(bucket.deletePrefix('../')).rejects.toThrow(/Invalid storage key/);
    expect(() => validateStorageKey('.tix-pre-update-probe')).not.toThrow();
    expect(() => validateStorageKey('media/image/2026/ab-12.webp')).not.toThrow();
  });

  it('does not follow symbolic links out of the directory', async () => {
    const base = await scratch();
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    const root = join(base, 'b');
    await mkdir(root);
    try {
      await symlink(outside, join(root, 'link'), 'dir');
      await symlink(join(outside, 'secret.txt'), join(root, 'file-link'));
    } catch {
      return; // no permission to create symlinks (Windows without developer mode)
    }
    const bucket = new FsBucket(root);
    await expect(bucket.getBytes('link/secret.txt')).rejects.toThrow(/outside/);
    await expect(bucket.putBytes('link/new.txt', 'x', 'text/plain')).rejects.toThrow(/outside/);
    await expect(bucket.getBytes('file-link')).rejects.toMatchObject({ name: 'NoSuchKey' });
    const listed: string[] = [];
    for await (const o of bucket.list('')) listed.push(o.key);
    expect(listed).toEqual([]);
    // Deleting through the link may be refused or ignored, but must never remove the outside file.
    await bucket.delete('link/secret.txt').catch(() => undefined);
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('keeps temp files and sidecars outside the bucket and cleans up', async () => {
    const base = await scratch();
    const bucket = new FsBucket(join(base, 'documents'));
    await bucket.putBytes('a/b/c.txt', 'x', 'text/plain');
    await bucket.putStream('a/d.bin', chunks('abc'), 'application/octet-stream');
    await expect(
      bucket.putStream(
        'a/e.bin',
        (async function* () {
          throw new Error('x');
        })(),
      ),
    ).rejects.toThrow('x');
    expect(await readdir(join(base, '.tmp'))).toEqual([]);
    expect((await readdir(join(base, 'documents'))).sort()).toEqual(['a']);
    expect((await readdir(join(base, 'documents', 'a'))).sort()).toEqual(['b', 'd.bin']);
    expect(await readdir(join(base, '.meta', 'documents', 'a'))).toContain('d.bin');
    await bucket.delete('a/b/c.txt');
    await bucket.delete('a/d.bin');
    // emptied directories (data and sidecars) are removed again
    expect(await readdir(join(base, 'documents'))).toEqual([]);
    expect(await readdir(join(base, '.meta', 'documents'))).toEqual([]);
  });

  it('reads while the object is being replaced see old or new, never a mix', async () => {
    const bucket = new FsBucket(join(await scratch(), 'b'));
    await bucket.putBytes('k', Buffer.alloc(200_000, 1), 'x/y');
    const writer = (async () => {
      for (let i = 2; i < 12; i += 1) await bucket.putBytes('k', Buffer.alloc(200_000, i), 'x/y');
    })();
    const reader = (async () => {
      for (let i = 0; i < 40; i += 1) {
        const data = await bucket.getBytes('k');
        expect(data.length).toBe(200_000);
        expect(new Set(data).size).toBe(1);
      }
    })();
    await Promise.all([writer, reader]);
  });

  it('supports a checkAccess on a directory that does not exist yet', async () => {
    const bucket = new FsBucket(join(await scratch(), 'fresh', 'backups'));
    const out: string[] = [];
    for await (const o of bucket.list('')) out.push(o.key);
    expect(out).toEqual([]);
    expect(await bucket.listDirectories('backups/')).toEqual([]);
    await bucket.checkAccess('.tix-connection-probe');
  });
});

describe('storage environment', () => {
  it('defaults to the filesystem when no S3 endpoint is set', () => {
    const parsed = parseStorageEnv({});
    expect(parsed.ok && parsed.config.driver).toBe('fs');
    const empty = parseStorageEnv({ S3_ENDPOINT: '', STORAGE_DRIVER: '', STORAGE_DIR: '' });
    expect(empty.ok && empty.config).toMatchObject({ driver: 'fs' });
    const custom = storageConfigFromEnv({ STORAGE_DIR: '/srv/tix' });
    expect(custom).toMatchObject({ driver: 'fs' });
    expect(custom.driver === 'fs' && custom.dir.replace(/\\/g, '/')).toMatch(/\/srv\/tix$/);
  });

  it('keeps existing installations on S3 (endpoint set, no new variables)', () => {
    const config = storageConfigFromEnv({
      S3_ENDPOINT: 'http://minio:9000',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_BUCKET_ASSETS: 'tix-assets',
      S3_BUCKET_DOCUMENTS: 'tix-documents',
    });
    expect(config).toMatchObject({
      driver: 's3',
      region: 'us-east-1',
      forcePathStyle: true,
      buckets: { assets: 'tix-assets', documents: 'tix-documents', backups: 'tix-backups' },
    });
    expect(createObjectStorage(config)).toBeInstanceOf(S3ObjectStorage);
    expect(createBackupBuckets(config).backups).toBeInstanceOf(S3Bucket);
  });

  it('validates the S3 variables only for the s3 driver', () => {
    expect(parseStorageEnv({ STORAGE_DRIVER: 'fs', S3_ENDPOINT: 'not a url' }).ok).toBe(true);
    const missing = parseStorageEnv({ STORAGE_DRIVER: 's3' });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_BUCKET_ASSETS']),
    );
    const same = parseStorageEnv({
      S3_ENDPOINT: 'http://x:9000',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_BUCKET_ASSETS: 'same-bucket',
      S3_BUCKET_DOCUMENTS: 'same-bucket',
    });
    expect(!same.ok && same.issues[0]?.message).toMatch(/three different buckets/);
    expect(parseStorageEnv({ STORAGE_DRIVER: 'ceph' }).ok).toBe(false);
  });

  it('copies S3-style buckets to the filesystem (migration helper)', async () => {
    const from = createBackupBuckets({ driver: 'fs', dir: await scratch() });
    const to = createBackupBuckets({ driver: 'fs', dir: await scratch() });
    await from.assets.putBytes('media/a.png', 'png', 'image/png');
    await from.documents.putBytes('invoices/2026/1.pdf', 'pdf', 'application/pdf');
    expect(await copyBuckets(from, to)).toMatchObject({ copied: 2, skipped: 0 });
    expect(await copyBuckets(from, to)).toMatchObject({ copied: 0, skipped: 2 });
    const copied = await to.documents.getStream('invoices/2026/1.pdf');
    expect(copied.contentType).toBe('application/pdf');
    (copied.stream as unknown as Readable).destroy(); // an opened stream holds its descriptor until it is read or destroyed
  });
});

describe('copyBuckets with unsafe keys', () => {
  it('does not copy objects whose key the target would reject and reports them', async () => {
    const good = { key: 'media/a.png', size: 3, lastModified: new Date() };
    const bad = { key: 'a\\b.png', size: 3, lastModified: new Date() };
    const source = (objects: (typeof good)[]) =>
      ({
        list: async function* () {
          for (const o of objects) yield o;
        },
        getStream: async () => ({
          stream: Readable.from([Buffer.from('png')]),
          size: 3,
          contentType: 'image/png',
        }),
      }) as never;
    const from = { assets: source([good, bad]), documents: source([]) };
    const to = createBackupBuckets({ driver: 'fs', dir: await scratch() });
    const result = await copyBuckets(from, to);
    expect(result).toMatchObject({ copied: 1, rejected: [{ area: 'assets', key: 'a\\b.png' }] });
  });
});

describe('filesystem storage: streaming, races and housekeeping', () => {
  it('getStream opens eagerly: a delete or overwrite during the download cannot abort it', async () => {
    const bucket = new FsBucket(join(await scratch(), 'b'));
    const original = Buffer.alloc(300_000, 7);
    await bucket.putBytes('big/k', original, 'application/x-test');
    const { stream, size, contentType } = await bucket.getStream('big/k');
    expect(size).toBe(original.length);
    expect(contentType).toBe('application/x-test');
    await bucket.delete('big/k'); // e.g. cleanup running while a backup streams the object
    const read: Buffer[] = [];
    for await (const chunk of stream) read.push(chunk as Buffer);
    expect(Buffer.concat(read).equals(original)).toBe(true);

    // Windows refuses to replace a file that is open (the Linux container does not).
    if (process.platform === 'win32') return;
    await bucket.putBytes('big/k', original, 'x/y');
    const second = await bucket.getStream('big/k');
    await bucket.putBytes('big/k', Buffer.alloc(10, 1), 'x/y'); // replaced meanwhile
    const again: Buffer[] = [];
    for await (const chunk of second.stream) again.push(chunk as Buffer);
    expect(Buffer.concat(again).equals(original)).toBe(true);
    expect(second.size).toBe(original.length);
  });

  it('getStream reports a missing key immediately (NoSuchKey) and refuses links', async () => {
    const base = await scratch();
    const root = join(base, 'b');
    const bucket = new FsBucket(root);
    await expect(bucket.getStream('nope')).rejects.toMatchObject({ name: 'NoSuchKey' });
    await expect(bucket.getStream('d/nope')).rejects.toMatchObject({ name: 'NoSuchKey' });
    await bucket.putBytes('dir/file', 'x', 'text/plain');
    await expect(bucket.getStream('dir')).rejects.toMatchObject({ name: 'NoSuchKey' });
    await writeFile(join(base, 'secret'), 'secret');
    try {
      await symlink(join(base, 'secret'), join(root, 'link'));
    } catch {
      return; // no permission to create symlinks
    }
    await expect(bucket.getStream('link')).rejects.toMatchObject({ name: 'NoSuchKey' });
  });

  it('stale temp files are swept once, fresh ones stay', async () => {
    const base = await scratch();
    const tmpDir = join(base, '.tmp');
    await mkdir(tmpDir);
    const old = join(tmpDir, '123-old');
    const fresh = join(tmpDir, '123-fresh');
    await writeFile(old, 'x');
    await writeFile(fresh, 'x');
    const longAgo = new Date(Date.now() - 25 * 3_600_000);
    await utimes(old, longAgo, longAgo);
    const storage = new FsObjectStorage(base);
    await storage.put('documents', 'a.txt', 'hello', 'text/plain');
    expect(await readdir(tmpDir)).toEqual(['123-fresh']);

    expect(await sweepStaleTmp(join(base, 'does-not-exist'))).toBe(0);
    await utimes(fresh, longAgo, longAgo);
    expect(await sweepStaleTmp(tmpDir)).toBe(1);
    expect(await sweepStaleTmp(tmpDir, 1_000, Date.now() + 5_000)).toBe(0);
  });

  it('concurrent put and delete of keys in the same directory never fail', async () => {
    const bucket = new FsBucket(join(await scratch(), 'b'));
    const jobs: Promise<unknown>[] = [];
    for (let round = 0; round < 60; round += 1) {
      jobs.push(bucket.putBytes('a/b/c/k', `v${round}`, 'text/plain'));
      jobs.push(bucket.delete('a/b/c/k'));
      jobs.push(bucket.putStream('a/b/c/s', chunks(`s${round}`), 'text/plain'));
      jobs.push(bucket.delete('a/b/c/s'));
    }
    await expect(Promise.all(jobs)).resolves.toBeDefined();
    await bucket.putBytes('a/b/c/k', 'final', 'text/plain');
    expect((await bucket.getBytes('a/b/c/k')).toString()).toBe('final');
  });

  it('list does not start inside a symbolic link, not even one to another bucket directory', async () => {
    const base = await scratch();
    const root = join(base, 'b');
    const bucket = new FsBucket(root);
    await bucket.putBytes('real/one.txt', 'x', 'text/plain');
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'o.txt'), 'x');
    try {
      await symlink(join(root, 'real'), join(root, 'alias'), 'dir');
      await symlink(outside, join(root, 'out'), 'dir');
    } catch {
      return; // no permission to create symlinks
    }
    const keys = async (prefix: string) => {
      const out: string[] = [];
      for await (const o of bucket.list(prefix)) out.push(o.key);
      return out;
    };
    expect(await keys('alias/')).toEqual([]);
    expect(await keys('out/')).toEqual([]);
    expect(await keys('out/o')).toEqual([]);
    expect(await keys('')).toEqual(['real/one.txt']);
    expect(await keys('real/')).toEqual(['real/one.txt']);
  });

  it('archive object keys are validated like storage keys while inspecting', () => {
    for (const bad of [
      '',
      '/abs',
      '../x',
      'a/../b',
      'a\b',
      'c:x',
      'trailing.',
      'a//b',
      'a\u0000b',
    ]) {
      expect(() => assertSafeObjectKey(bad), JSON.stringify(bad)).toThrow(/invalid file name/);
    }
    expect(() => assertSafeObjectKey('media/image/2026/ab-12.webp')).not.toThrow();
    expect(() => assertSafeObjectKey('.tix-probe')).not.toThrow();
  });
});
