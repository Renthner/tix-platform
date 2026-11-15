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
  return spec === '' ? [] : parseKeyRing(spec);
}

/** Serialises entries as `id:base64` lines (the format of the extra keys file). */
export function formatKeyRingText(keys: readonly SecretBoxKey[]): string {
  return keys.map((k) => `${k.id}:${k.key.toString('base64')}`).join('\n');
}

/**
 * Concatenates rings in order (earlier rings win positions). The same id with the same material
 * is merged; the same id with DIFFERENT material is rejected: envelopes and archives only carry
 * the id, so two materials under one id could not be told apart.
 */
export function mergeKeyRings(...rings: ReadonlyArray<readonly SecretBoxKey[]>): SecretBoxKey[] {
  const merged: SecretBoxKey[] = [];
  for (const ring of rings) {
    for (const key of ring) {
      const existing = merged.find((k) => k.id === key.id);
      if (!existing) merged.push(key);
      else if (!existing.key.equals(key.key)) {
        throw new SecretBoxError(
          `The key id "${key.id}" is already used here with a different key. Give one of the two keys a different id.`,
        );
      }
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
 * Stores `keys` as additional (decrypt-only) keys. Throws on an id collision with the configured
 * ring or the existing file (different material) BEFORE anything is written. Entries that the
 * configured ring already contains are not stored; entries already in the file are kept. Returns the ids that are new in the file.
 */
export function persistExtraKeys(
  keys: readonly SecretBoxKey[],
  configured: readonly SecretBoxKey[],
  env: EnvSource = process.env,
): string[] {
  const path = extraKeysPath(env);
  const existing = loadExtraKeys(path);
  mergeKeyRings(configured, existing, keys); // collisions throw before anything is written
  const fresh = keys.filter((k) => !configured.some((c) => c.id === k.id));
  const stored = mergeKeyRings(existing, fresh);
  const added = stored.filter((k) => !existing.some((e) => e.id === k.id)).map((k) => k.id);
  if (added.length === 0) return [];
  writeFileDurably(path, `${formatKeyRingText(stored)}\n`);
  // Read back from disk (not from memory) before the caller proceeds to replace the database.
  const back = loadExtraKeys(path);
  const same =
    back.length === stored.length &&
    stored.every((k) => back.some((b) => b.id === k.id && b.key.equals(k.key)));
  if (!same) {
    throw new SecretBoxError(
      `Additional encryption keys: ${path} could not be verified after writing`,
    );
  }
  return added;
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
      if (next.length === ring.length) return false;
      ring = next;
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
      if (
        err instanceof SecretBoxError &&
        err.message.startsWith('Unknown encryption key id') &&
        reload()
      ) {
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
