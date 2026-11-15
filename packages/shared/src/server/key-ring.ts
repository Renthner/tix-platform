import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createSecretBox,
  parseKeyRing,
  parseKeyRingLoose,
  ringFingerprint,
  SecretBoxError,
  type SecretBox,
  type SecretBoxKey,
} from './secret-box';

/**
 * Key ring = `APP_ENCRYPTION_KEYS` (operator supplied, the first key encrypts) PLUS an optional
 * file of ADDITIONAL keys that were entered when a backup of another system was restored. The
 * additional keys only decrypt (they are always appended behind the configured ring); the file
 * lives on the data volume (`<TIX_SECRETS_DIR or /data/secrets>/extra-encryption-keys`, override
 * with `TIX_EXTRA_KEYS_FILE`), one `id:base64` entry per line, mode 0600.
 *
 * The ring maps an id to a LIST of candidate keys: another installation may have used the same id
 * (`k1`) with different material. Decryption tries every candidate of the envelope's id (AES-GCM
 * tells the right one), encryption always uses the first configured key. After the restored secrets
 * were re-encrypted (`reEncryptSecrets`) the file is removed again (`removeExtraKeys`).
 */

export const EXTRA_KEYS_FILENAME = 'extra-encryption-keys';
const RELOAD_THROTTLE_MS = 5_000;

type EnvSource = Record<string, string | undefined>;

export function extraKeysPath(env: EnvSource = process.env): string {
  const explicit = env.TIX_EXTRA_KEYS_FILE;
  if (explicit) return explicit;
  return join(env.TIX_SECRETS_DIR || '/data/secrets', EXTRA_KEYS_FILENAME);
}

/**
 * Parses ring text typed or pasted by an admin: entries separated by commas, spaces or new
 * lines; tolerates a pasted `APP_ENCRYPTION_KEYS=` prefix and surrounding quotes. An empty
 * text gives an empty list. Errors never contain key material.
 */
export function parseKeyRingText(text: string): SecretBoxKey[] {
  const cleaned = text
    .trim()
    .replace(/^(export\s+)?APP_ENCRYPTION_KEYS\s*=\s*/i, '')
    .replace(/^["']|["']$/g, '');
  const spec = cleaned
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(',');
  return spec === '' ? [] : parseKeyRingLoose(spec);
}

/** Serialises entries as `id:base64` lines (the format of the extra keys file). */
export function formatKeyRingText(keys: readonly SecretBoxKey[]): string {
  return keys.map((k) => `${k.id}:${k.key.toString('base64')}`).join('\n');
}

/**
 * Concatenates rings in order (earlier rings win positions; the first key of the first ring stays
 * the encryption key). The same id AND material is merged; the same id with different material is
 * kept as a further candidate for that id.
 */
export function mergeKeyRings(...rings: ReadonlyArray<readonly SecretBoxKey[]>): SecretBoxKey[] {
  const merged: SecretBoxKey[] = [];
  for (const ring of rings) {
    for (const key of ring) {
      if (!merged.some((k) => k.id === key.id && k.key.equals(key.key))) merged.push(key);
    }
  }
  return merged;
}

/**
 * Keys of the additional keys file (STRICT). A missing file is an empty list; an empty file (only
 * whitespace) also - it is logged, because it usually means the file was cut short. An unreadable or
 * non-parsable file is an error (never silently treated as "no keys"). `persistExtraKeys` uses
 * this strict form so it can never overwrite a broken file and drop the keys inside it.
 */
export function loadExtraKeys(path: string = extraKeysPath()): SecretBoxKey[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new SecretBoxError(`Additional encryption keys: cannot read ${path}`);
  }
  if (text.trim() === '') {
    logOnce(
      `empty:${path}`,
      `Additional encryption keys: ${path} is empty; treating it as "no additional keys". If a restore of another system's backup added keys before, the file was truncated: restore the file from a backup or re-enter the keys.`,
    );
    return [];
  }
  try {
    return parseKeyRingText(text);
  } catch {
    throw new SecretBoxError(`Additional encryption keys: ${path} is not a valid key file`);
  }
}

/**
 * Tolerant variant for process startup / the effective ring: a broken file must not crash-loop the
 * web server and worker. The problem is logged loudly and the process continues with the configured
 * keys only; secrets that need an additional key then fail with an error that names the file (see
 * `createReloadingSecretBox`). Fix or restore the file and the keys are picked up again.
 */
export function loadExtraKeysTolerant(path: string = extraKeysPath()): {
  keys: SecretBoxKey[];
  problem: string | null;
} {
  try {
    return { keys: loadExtraKeys(path), problem: null };
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err);
    logOnce(
      `broken:${path}:${problem}`,
      `${problem}. Continuing with the configured APP_ENCRYPTION_KEYS only: data encrypted with keys from that file cannot be read until the file is repaired or restored.`,
    );
    return { keys: [], problem };
  }
}

const logged = new Set<string>();
function logOnce(id: string, message: string): void {
  if (logged.has(id)) return;
  logged.add(id);
  console.error(`[tix] ${message}`);
}

/** The effective ring: `APP_ENCRYPTION_KEYS` first (encrypts), then the additional keys (decrypt only). */
export function loadKeyRing(spec: string, env: EnvSource = process.env): SecretBoxKey[] {
  return mergeKeyRings(parseKeyRing(spec), loadExtraKeysTolerant(extraKeysPath(env)).keys);
}

/**
 * Stores `keys` as additional (decrypt-only) keys. Entries the configured ring or the file already
 * contain (same id and material) are not stored again; the same id with other material IS stored
 * (candidate per id). Returns the ids of the entries that are new in the file.
 */
export function persistExtraKeys(
  keys: readonly SecretBoxKey[],
  configured: readonly SecretBoxKey[],
  env: EnvSource = process.env,
): string[] {
  const path = extraKeysPath(env);
  const existing = loadExtraKeys(path);
  const known = mergeKeyRings(configured, existing);
  const fresh = mergeKeyRings(
    keys.filter((k) => !known.some((c) => c.id === k.id && c.key.equals(k.key))),
  );
  if (fresh.length === 0) return [];
  const stored = mergeKeyRings(existing, fresh);
  writeFileDurably(
    path,
    `${formatKeyRingText(stored)}
`,
  );
  verifyExtraKeys(path, stored);
  return fresh.map((k) => k.id);
}

/** Read back from disk (not from memory) before the caller relies on the file. */
function verifyExtraKeys(path: string, expected: readonly SecretBoxKey[]): void {
  const back = loadExtraKeys(path);
  const same =
    back.length === expected.length &&
    expected.every((k) => back.some((b) => b.id === k.id && b.key.equals(k.key)));
  if (!same) {
    throw new SecretBoxError(
      `Additional encryption keys: ${path} could not be verified after writing`,
    );
  }
}

/**
 * Removes entries (all when `which` is omitted) from the additional keys file; the file itself is
 * deleted when nothing is left (an empty file would be logged as truncated). Only call this once
 * nothing stored in the database needs the keys any more. Returns the number of removed entries.
 */
export function removeExtraKeys(
  which?: readonly SecretBoxKey[],
  env: EnvSource = process.env,
): number {
  const path = extraKeysPath(env);
  const existing = loadExtraKeys(path);
  const remaining = which
    ? existing.filter((k) => !which.some((w) => w.id === k.id && w.key.equals(k.key)))
    : [];
  const removed = existing.length - remaining.length;
  if (removed === 0) return 0;
  if (remaining.length === 0) {
    unlinkSync(path);
  } else {
    writeFileDurably(
      path,
      `${formatKeyRingText(remaining)}
`,
    );
    verifyExtraKeys(path, remaining);
  }
  return removed;
}

/**
 * Crash-safe replace: unique exclusive temp file next to the target (`wx` = O_EXCL, so an existing
 * file or a planted symlink at that name is never followed), fsync the data, rename over the target
 * (atomic), fsync the directory so the rename survives a power loss.
 */
function writeFileDurably(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already renamed or gone */
    }
    throw err;
  }
  try {
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* directories cannot be opened/fsynced on every platform (Windows) */
  }
}

/**
 * SecretBox over the configured ring that picks up additional keys on demand: when an envelope
 * names an unknown key id the additional keys file is re-read (throttled) and the decryption is
 * tried again, so a restore that added keys works in this long-running process without restart.
 */
export function createReloadingSecretBox(spec: string, env: EnvSource = process.env): SecretBox {
  const configured = parseKeyRing(spec);
  const path = extraKeysPath(env);
  // A broken file is logged and skipped (no crash loop); unknown-key errors then name the file.
  const initial = loadExtraKeysTolerant(path);
  let problem = initial.problem;
  let ring = mergeKeyRings(configured, initial.keys);
  let fingerprint = ringFingerprint(ring);
  let inner = createSecretBox(ring);
  let lastReload = 0;

  const reload = (): boolean => {
    const now = Date.now();
    if (now - lastReload < RELOAD_THROTTLE_MS) return false;
    lastReload = now;
    try {
      const loaded = loadExtraKeysTolerant(path);
      problem = loaded.problem;
      const next = mergeKeyRings(configured, loaded.keys);
      const nextFingerprint = ringFingerprint(next);
      if (nextFingerprint === fingerprint) return false;
      ring = next;
      fingerprint = nextFingerprint;
      inner = createSecretBox(ring);
      return true;
    } catch {
      return false;
    }
  };

  const decrypt = (envelope: string, context: string): string => {
    try {
      return inner.decrypt(envelope, context);
    } catch (err) {
      // Unknown id, or (an id shared with another system's key) a failed authentication: the file
      // may have gained keys since this process read it.
      if (err instanceof SecretBoxError && reload()) {
        return inner.decrypt(envelope, context);
      }
      if (
        problem &&
        err instanceof SecretBoxError &&
        err.message.startsWith('Unknown encryption key id')
      ) {
        throw new SecretBoxError(`${err.message} (${problem})`);
      }
      throw err;
    }
  };

  return {
    get activeKeyId() {
      return configured[0]!.id;
    },
    encrypt: (plaintext, context) => inner.encrypt(plaintext, context),
    decrypt,
    encryptJson: (value, context) => inner.encrypt(JSON.stringify(value), context),
    decryptJson: <T>(envelope: string, context: string) =>
      JSON.parse(decrypt(envelope, context)) as T,
    needsReEncryption: (envelope) => inner.needsReEncryption(envelope),
  };
}
