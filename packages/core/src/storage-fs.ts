import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BackupBucket, BackupObjectInfo } from './backup/bucket';
import type { ObjectStorage, StorageBucket } from './storage';

/**
 * Filesystem storage: the default driver for new installations. A bucket is a directory below the
 * storage directory (`<dir>/assets`, `<dir>/documents`, `<dir>/backups`); keys are relative paths.
 *
 * - Writes are atomic: content goes to `<dir>/.tmp`, is fsynced and renamed into place, so a reader
 *   (or a crash) never sees a half-written object. The content type lives in a sidecar file below
 *   `<dir>/.meta/<bucket>/<key>`; temp files and sidecars are outside the bucket directories and
 *   therefore never listed or backed up.
 * - Keys are validated (no `..`, no absolute paths, no backslashes, colons or control characters)
 *   and every access checks that the real path stays inside the bucket directory; symbolic links
 *   are neither followed nor listed.
 * - Missing objects raise an error named `NoSuchKey` (HTTP-404 `$metadata`) like the S3 SDK, so the
 *   existing not-found handling works unchanged.
 * - Not provided: object versioning (S3 mode with versioning keeps old versions) and sharing
 *   between several hosts (use one node, or a shared volume with working rename/fsync semantics).
 */

export class StorageNotFoundError extends Error {
  override readonly name = 'NoSuchKey';
  readonly $metadata = { httpStatusCode: 404 };
  constructor(where: string) {
    super(`Object ${where} does not exist`);
  }
}

export class InvalidStorageKeyError extends Error {
  override readonly name = 'InvalidStorageKey';
  constructor(key: string, reason: string) {
    super(`Invalid storage key ${JSON.stringify(key.slice(0, 120))}: ${reason}`);
  }
}

const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\:]/;
const MAX_KEY_BYTES = 1024;

function checkSegments(key: string, segments: string[], allowTrailingEmpty: boolean): void {
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '') {
      if (allowTrailingEmpty && last && index > 0) return;
      throw new InvalidStorageKeyError(key, 'empty path segment');
    }
    if (segment === '.' || segment === '..') {
      throw new InvalidStorageKeyError(key, 'relative path segment');
    }
    if (segment.length > 255) throw new InvalidStorageKeyError(key, 'segment too long');
    // A trailing dot or space is silently dropped by Windows and would alias another key.
    if (/[. ]$/.test(segment) && !(allowTrailingEmpty && last)) {
      throw new InvalidStorageKeyError(key, 'segment ends with a dot or space');
    }
  });
}

/** Path segments of a valid object key; throws {@link InvalidStorageKeyError} otherwise. */
export function validateStorageKey(key: string): string[] {
  if (typeof key !== 'string' || key === '') throw new InvalidStorageKeyError(String(key), 'empty');
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new InvalidStorageKeyError(key, 'too long');
  if (FORBIDDEN_CHARS.test(key)) throw new InvalidStorageKeyError(key, 'forbidden character');
  if (key.startsWith('/')) throw new InvalidStorageKeyError(key, 'absolute path');
  const segments = key.split('/');
  checkSegments(key, segments, false);
  return segments;
}

/** Same rules for a listing prefix: may be empty, end with `/` or end in a partial name. */
function validatePrefix(prefix: string): void {
  if (prefix === '') return;
  if (Buffer.byteLength(prefix) > MAX_KEY_BYTES)
    throw new InvalidStorageKeyError(prefix, 'too long');
  if (FORBIDDEN_CHARS.test(prefix)) throw new InvalidStorageKeyError(prefix, 'forbidden character');
  if (prefix.startsWith('/')) throw new InvalidStorageKeyError(prefix, 'absolute path');
  const segments = prefix.split('/');
  // The last segment is a partial name (or empty after a trailing slash): only `.`/`..` matter.
  const last = segments.pop()!;
  checkSegments(prefix, segments, false);
  if (last === '.' || last === '..') throw new InvalidStorageKeyError(prefix, 'relative segment');
}

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code;
const isMissing = (err: unknown) => code(err) === 'ENOENT' || code(err) === 'ENOTDIR';

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Directory fsync makes the rename durable; not possible on Windows, so best effort. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // unsupported platform / filesystem
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      // Windows: the target is briefly locked by a concurrent reader or scanner.
      const transient = ['EPERM', 'EBUSY', 'EACCES'].includes(code(err) ?? '');
      if (!transient || process.platform !== 'win32' || attempt >= 8) throw err;
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

/** O_NOFOLLOW where the platform has it (not on Windows): a symlink swapped in is refused. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Opens a regular file for reading without following a symbolic link in the last path component.
 * Where O_NOFOLLOW does not exist the opened file is compared with the lstat of the path (retrying
 * when the object was replaced in between). Returns null when the key is not a plain file.
 */
async function openRegularFile(
  target: string,
): Promise<{ handle: FileHandle; size: number } | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let before;
    try {
      before = await lstat(target);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (!before.isFile()) return null; // symbolic links and directories are not objects
    let handle: FileHandle;
    try {
      handle = await open(target, fsConstants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (isMissing(err) || code(err) === 'ELOOP') return null;
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        await handle.close();
        return null;
      }
      const swapped =
        O_NOFOLLOW === 0 && info.ino !== 0 && before.ino !== 0 && info.ino !== before.ino;
      if (!swapped) return { handle, size: info.size };
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    await handle.close().catch(() => undefined);
  }
  return null;
}

export const STALE_TMP_MS = 24 * 3_600_000;
const sweeps = new Map<string, Promise<void>>();

/**
 * Removes temp files older than `maxAgeMs` (default 24 h) from `tmpRoot`: the leftovers of a
 * process that was killed mid-upload. Files are only ever in use for the duration of one write,
 * and every write refreshes the modification time. Returns the number of removed files.
 */
export async function sweepStaleTmp(
  tmpRoot: string,
  maxAgeMs = STALE_TMP_MS,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(tmpRoot);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(tmpRoot, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || now - info.mtimeMs <= maxAgeMs) continue;
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // vanished or not removable: not our problem
    }
  }
  return removed;
}

/**
 * Renames into `target`, re-creating its parent directory first. A concurrent delete prunes
 * directories that just became empty, which can remove the parent between the writer's mkdir and
 * its rename (ENOENT); the whole step is therefore retried.
 */
async function renameInto(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await mkdir(dirname(to), { recursive: true });
    try {
      await renameWithRetry(from, to);
      return;
    } catch (err) {
      if (code(err) !== 'ENOENT' || attempt >= 8) throw err;
      await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
    }
  }
}

export interface FsBucketOptions {
  /** Directory of this bucket. */
  root: string;
  /** Content-type sidecars; default `<parent of root>/.meta/<name of root>` (never inside `root`). */
  metaRoot?: string;
  /** Temp files (must be on the same volume as `root`); default `<parent of root>/.tmp`. */
  tmpRoot?: string;
}

/** One directory as a key space; implements what backups need and backs {@link FsObjectStorage}. */
export class FsBucket implements BackupBucket {
  readonly bucket: string;
  readonly localPath: string;
  private readonly metaRoot: string;
  private readonly tmpRoot: string;

  constructor(options: FsBucketOptions | string) {
    const opts = typeof options === 'string' ? { root: options } : options;
    this.localPath = resolve(opts.root);
    this.bucket = basename(this.localPath);
    this.metaRoot = resolve(opts.metaRoot ?? join(dirname(this.localPath), '.meta', this.bucket));
    this.tmpRoot = resolve(opts.tmpRoot ?? join(dirname(this.localPath), '.tmp'));
  }

  // ── path handling ────────────────────────────────────────────────────────

  /**
   * Absolute path of a key. Checks that the real parent directory is inside `base`. For writes the
   * parent directories are created first.
   */
  private async locate(
    base: string,
    segments: readonly string[],
    forWrite: boolean,
    where: string,
  ): Promise<string> {
    const target = join(base, ...segments);
    const parent = dirname(target);
    if (forWrite) await mkdir(parent, { recursive: true });
    let realBase: string;
    let realParent: string;
    try {
      realBase = await realpath(base);
      realParent = await realpath(parent);
    } catch (err) {
      if (isMissing(err)) throw new StorageNotFoundError(where);
      throw err;
    }
    if (realParent !== realBase && !realParent.startsWith(realBase + sep)) {
      throw new InvalidStorageKeyError(where, 'resolves outside of the storage directory');
    }
    return target;
  }

  private metaPath(segments: readonly string[]): string {
    return join(this.metaRoot, ...segments);
  }

  private async readContentType(segments: readonly string[]): Promise<string | undefined> {
    try {
      const text = (await readFile(this.metaPath(segments), 'utf8')).trim();
      return text === '' ? undefined : text;
    } catch {
      return undefined;
    }
  }

  private async tempPath(): Promise<string> {
    await mkdir(this.tmpRoot, { recursive: true });
    // Once per process and temp directory (shared by all buckets of a storage directory).
    if (!sweeps.has(this.tmpRoot))
      sweeps.set(
        this.tmpRoot,
        sweepStaleTmp(this.tmpRoot).then(() => {}),
      );
    await sweeps.get(this.tmpRoot);
    return join(this.tmpRoot, `${process.pid}-${randomBytes(8).toString('hex')}`);
  }

  /** Writes a small file atomically (temp + fsync + rename). */
  private async atomicWrite(target: string, content: string | Uint8Array): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const tmp = await this.tempPath();
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameInto(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Moves a finished temp file into place and records the content type. */
  private async commit(
    tmp: string,
    target: string,
    segments: readonly string[],
    contentType: string,
  ): Promise<void> {
    try {
      await this.atomicWrite(this.metaPath(segments), contentType);
      await renameInto(tmp, target);
      await syncDirectory(dirname(target));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async openRead(key: string) {
    const segments = validateStorageKey(key);
    const where = `${this.bucket}/${key}`;
    const target = await this.locate(this.localPath, segments, false, where);
    const opened = await openRegularFile(target);
    if (!opened) throw new StorageNotFoundError(where);
    return { ...opened, segments };
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * Streaming read. The file is opened right away and streamed from that very handle, so a later
   * delete or replacement of the key (a concurrent cleanup, an overwrite) cannot abort a running
   * download or backup, and the size belongs to the bytes that are actually delivered. A missing
   * key fails here with NoSuchKey. The descriptor is released when the stream ends, fails or is
   * destroyed: consumers must read it to the end or destroy it.
   */
  async getStream(
    key: string,
  ): Promise<{ stream: Readable; size: number; contentType: string | undefined }> {
    const { handle, size, segments } = await this.openRead(key);
    try {
      const contentType = await this.readContentType(segments);
      return { stream: handle.createReadStream({ autoClose: true }), size, contentType };
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  }

  async getObject(key: string): Promise<{ body: Buffer; contentType: string | undefined }> {
    const { handle, segments } = await this.openRead(key);
    try {
      const body = await handle.readFile();
      return { body, contentType: await this.readContentType(segments) };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async getBytes(key: string): Promise<Buffer> {
    return (await this.getObject(key)).body;
  }

  async tryGetBytes(key: string): Promise<Buffer | null> {
    try {
      return await this.getBytes(key);
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────

  async putBytes(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
    const segments = validateStorageKey(key);
    const target = await this.locate(this.localPath, segments, true, `${this.bucket}/${key}`);
    const tmp = await this.tempPath();
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await this.commit(tmp, target, segments, contentType);
  }

  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    contentType = 'application/octet-stream',
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const segments = validateStorageKey(key);
    const target = await this.locate(this.localPath, segments, true, `${this.bucket}/${key}`);
    const tmp = await this.tempPath();
    const hash = createHash('sha256');
    let sizeBytes = 0;
    async function* tap(): AsyncGenerator<Uint8Array> {
      for await (const piece of source) {
        hash.update(piece);
        sizeBytes += piece.byteLength;
        yield piece;
      }
    }
    try {
      await pipeline(Readable.from(tap()), createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      await syncFile(tmp);
    } catch (err) {
      // Abort: nothing of the partial upload stays behind.
      await rm(tmp, { force: true });
      throw err;
    }
    await this.commit(tmp, target, segments, contentType);
    return { sizeBytes, sha256: hash.digest('hex') };
  }

  // ── deletes ──────────────────────────────────────────────────────────────

  /** Removes empty directories from `dir` upwards, stopping at `base`. */
  private async pruneEmpty(base: string, dir: string): Promise<void> {
    let current = dir;
    while (current !== base && current.startsWith(base + sep)) {
      try {
        await rmdir(current);
      } catch {
        return; // not empty (or gone)
      }
      current = dirname(current);
    }
  }

  async delete(key: string): Promise<void> {
    const segments = validateStorageKey(key);
    let target: string;
    try {
      target = await this.locate(this.localPath, segments, false, `${this.bucket}/${key}`);
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return; // deleting a missing key is a no-op
      throw err;
    }
    try {
      await unlink(target);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    await rm(this.metaPath(segments), { force: true });
    await this.pruneEmpty(this.localPath, dirname(target));
    await this.pruneEmpty(this.metaRoot, dirname(this.metaPath(segments)));
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) await this.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys: string[] = [];
    for await (const o of this.list(prefix)) keys.push(o.key);
    await this.deleteMany(keys);
    return keys.length;
  }

  // ── listing ──────────────────────────────────────────────────────────────

  private async *walk(
    absDir: string,
    keyDir: string,
    prefix: string,
  ): AsyncGenerator<BackupObjectInfo> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    // Order of the full keys: a directory sorts as `name/`.
    const sorted = entries
      .filter((e) => !e.isSymbolicLink() && (e.isDirectory() || e.isFile()))
      .map((e) => ({ entry: e, sortKey: e.isDirectory() ? `${e.name}/` : e.name }))
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    for (const { entry, sortKey } of sorted) {
      const key = keyDir + sortKey;
      if (entry.isDirectory()) {
        if (key.startsWith(prefix) || prefix.startsWith(key)) {
          yield* this.walk(join(absDir, entry.name), key, prefix);
        }
      } else if (key.startsWith(prefix)) {
        try {
          const info = await stat(join(absDir, entry.name));
          yield { key, size: info.size, lastModified: info.mtime };
        } catch (err) {
          if (!isMissing(err)) throw err; // deleted while listing
        }
      }
    }
  }

  async *list(prefix: string): AsyncGenerator<BackupObjectInfo> {
    validatePrefix(prefix);
    const cut = prefix.lastIndexOf('/');
    const dirPart = prefix.slice(0, cut + 1);
    const segments = dirPart.split('/').filter(Boolean);
    // The start directory must be a real directory chain inside the bucket: a symbolic link on the
    // way (even to another directory of the bucket) is not listed, like in the walk below.
    let current = this.localPath;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) return;
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
    }
    if (segments.length > 0) {
      try {
        const realBase = await realpath(this.localPath);
        const realStart = await realpath(current);
        if (realStart !== realBase && !realStart.startsWith(realBase + sep)) return;
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
    }
    yield* this.walk(current, dirPart, prefix);
  }

  async listDirectories(prefix: string): Promise<string[]> {
    const dirs: string[] = [];
    for await (const object of this.list(prefix)) {
      const rest = object.key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const dir = prefix + rest.slice(0, slash + 1);
      if (dirs[dirs.length - 1] !== dir) dirs.push(dir);
    }
    return dirs;
  }

  /** Writable-directory check: create, write, read back and delete a small probe object. */
  async checkAccess(probeKey: string): Promise<void> {
    await mkdir(this.localPath, { recursive: true });
    const payload = `tix-backup-probe ${new Date().toISOString()}`;
    await this.putBytes(probeKey, payload, 'text/plain');
    const back = (await this.getBytes(probeKey)).toString('utf8');
    await this.delete(probeKey);
    if (back !== payload) throw new Error('Probe object read back differently');
  }

  destroy(): void {
    // nothing to release
  }
}

/** The filesystem implementation of {@link ObjectStorage}: `<dir>/assets` and `<dir>/documents`. */
export class FsObjectStorage implements ObjectStorage {
  readonly driver = 'fs' as const;
  private readonly buckets: Record<StorageBucket, FsBucket>;

  constructor(readonly dir: string) {
    const base = resolve(dir);
    const make = (name: StorageBucket) =>
      new FsBucket({
        root: join(base, name),
        metaRoot: join(base, '.meta', name),
        tmpRoot: join(base, '.tmp'),
      });
    this.buckets = { assets: make('assets'), documents: make('documents') };
  }

  put(
    bucket: StorageBucket,
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    return this.buckets[bucket].putBytes(key, body, contentType);
  }

  async get(
    bucket: StorageBucket,
    key: string,
  ): Promise<{ body: Uint8Array; contentType: string | undefined }> {
    return this.buckets[bucket].getObject(key);
  }

  async getStream(
    bucket: StorageBucket,
    key: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | undefined }> {
    const { stream, contentType } = await this.buckets[bucket].getStream(key);
    return { stream: Readable.toWeb(stream) as ReadableStream<Uint8Array>, contentType };
  }

  async list(
    bucket: StorageBucket,
    prefix: string,
  ): Promise<{ key: string; lastModified: Date | undefined }[]> {
    const out: { key: string; lastModified: Date | undefined }[] = [];
    for await (const o of this.buckets[bucket].list(prefix)) {
      out.push({ key: o.key, lastModified: o.lastModified });
    }
    return out;
  }

  delete(bucket: StorageBucket, key: string): Promise<void> {
    return this.buckets[bucket].delete(key);
  }
}
