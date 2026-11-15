import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SecretBoxError,
  createReloadingSecretBox,
  createSecretBox,
  extraKeysPath,
  formatKeyRingText,
  loadExtraKeys,
  loadKeyRing,
  mergeKeyRings,
  parseKeyRing,
  parseKeyRingLoose,
  parseKeyRingText,
  persistExtraKeys,
  removeExtraKeys,
  ringFingerprint,
} from '../src/server';

const entry = (id: string) => `${id}:${randomBytes(32).toString('base64')}`;

describe('additional (decrypt-only) key ring', () => {
  let dir: string;
  let env: Record<string, string>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tix-keys-'));
    env = { TIX_EXTRA_KEYS_FILE: join(dir, 'secrets', 'extra-encryption-keys') };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves the file path from TIX_EXTRA_KEYS_FILE or TIX_SECRETS_DIR', () => {
    expect(extraKeysPath({ TIX_EXTRA_KEYS_FILE: '/x/y' })).toBe('/x/y');
    expect(extraKeysPath({ TIX_SECRETS_DIR: '/s' }).replace(/\\/g, '/')).toBe(
      '/s/extra-encryption-keys',
    );
    expect(extraKeysPath({}).replace(/\\/g, '/')).toBe('/data/secrets/extra-encryption-keys');
  });

  it('parses pasted text: commas, lines, env prefix, quotes; rejects garbage without echoing it', () => {
    const a = entry('a1');
    const b = entry('b2');
    expect(parseKeyRingText(`APP_ENCRYPTION_KEYS="${a},${b}"`).map((k) => k.id)).toEqual([
      'a1',
      'b2',
    ]);
    expect(parseKeyRingText(`${a}\n${b}\n`).map((k) => k.id)).toEqual(['a1', 'b2']);
    expect(parseKeyRingText('  ')).toEqual([]);
    const secretLooking = 'zz:' + Buffer.from('short-secret-material').toString('base64');
    try {
      parseKeyRingText(secretLooking);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(
        Buffer.from('short-secret-material').toString('base64'),
      );
    }
  });

  it('merges identical entries and keeps the same id with different material as a candidate', () => {
    const a = parseKeyRing(entry('k1'));
    expect(mergeKeyRings(a, a)).toHaveLength(1);
    const other = parseKeyRing(entry('k1'));
    const merged = mergeKeyRings(a, other);
    expect(merged.map((k) => k.id)).toEqual(['k1', 'k1']);
    // The first ring keeps the first position (it encrypts).
    expect(merged[0]!.key.equals(a[0]!.key)).toBe(true);
    expect(mergeKeyRings(a, parseKeyRing(entry('k2'))).map((k) => k.id)).toEqual(['k1', 'k2']);
  });

  it('the env ring still refuses duplicate ids, the loose parser accepts them', () => {
    expect(() => parseKeyRing(`${entry('k1')},${entry('k1')}`)).toThrow(/Duplicate key ids/);
    expect(parseKeyRingLoose(`${entry('k1')},${entry('k1')}`)).toHaveLength(2);
    expect(parseKeyRingLoose('')).toEqual([]);
  });

  it('a secret box tries every candidate of an id and always encrypts with the first key', () => {
    const own = parseKeyRing(entry('k1'));
    const foreign = parseKeyRing(entry('k1'));
    const foreignBox = createSecretBox(foreign);
    const envelope = foreignBox.encrypt('from the other system', 'ctx');
    const box = createSecretBox(mergeKeyRings(own, foreign));
    expect(box.decrypt(envelope, 'ctx')).toBe('from the other system');
    expect(() => box.decrypt(envelope, 'other-context')).toThrow(SecretBoxError);
    // Encrypts with the own key: the own-only box opens it, the foreign box does not.
    const fresh = box.encrypt('x', 'ctx');
    expect(createSecretBox(own).decrypt(fresh, 'ctx')).toBe('x');
    expect(() => foreignBox.decrypt(fresh, 'ctx')).toThrow(SecretBoxError);
    // Only the own key: the foreign envelope has the same id but cannot be opened.
    expect(() => createSecretBox(own).decrypt(envelope, 'ctx')).toThrow(/could not be decrypted/);
  });

  it('ring fingerprints ignore order and notice a different key under the same id', () => {
    const a = parseKeyRing(entry('k1'));
    const b = parseKeyRing(entry('k1'));
    expect(ringFingerprint([...a, ...b])).toBe(ringFingerprint([...b, ...a]));
    expect(ringFingerprint(a)).not.toBe(ringFingerprint(b));
  });

  it('persists additional keys (mode 0600), keeps existing entries and is idempotent', () => {
    const configured = parseKeyRing(entry('cur'));
    const a = parseKeyRing(entry('src1'));
    const b = parseKeyRing(entry('src2'));
    expect(loadExtraKeys(extraKeysPath(env))).toEqual([]);
    expect(persistExtraKeys(a, configured, env)).toEqual(['src1']);
    expect(persistExtraKeys(a, configured, env)).toEqual([]);
    expect(persistExtraKeys(b, configured, env)).toEqual(['src2']);
    const stored = loadExtraKeys(extraKeysPath(env));
    expect(stored.map((k) => k.id)).toEqual(['src1', 'src2']);
    expect(stored[0]!.key.equals(a[0]!.key)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(extraKeysPath(env)).mode & 0o777).toBe(0o600);
    }
    // A key that is already part of the configured ring is not stored again.
    expect(persistExtraKeys(configured, configured, env)).toEqual([]);
    expect(readFileSync(extraKeysPath(env), 'utf8')).not.toContain('cur:');
  });

  it('stores a key with the same id but other material as a further candidate (no collision error)', () => {
    const configured = parseKeyRing(entry('k1'));
    const foreign = parseKeyRing(entry('k1'));
    expect(persistExtraKeys(foreign, configured, env)).toEqual(['k1']);
    // Same id AND material as the configured key: nothing to store; same as the file: idempotent.
    expect(persistExtraKeys(configured, configured, env)).toEqual([]);
    expect(persistExtraKeys(foreign, configured, env)).toEqual([]);
    expect(loadExtraKeys(extraKeysPath(env))).toHaveLength(1);
    const ring = mergeKeyRings(configured, loadExtraKeys(extraKeysPath(env)));
    expect(ring).toHaveLength(2);
    expect(ring[0]!.key.equals(configured[0]!.key)).toBe(true);
  });

  it('removeExtraKeys removes selected entries, deletes the file when none is left', () => {
    const configured = parseKeyRing(entry('cur'));
    const a = parseKeyRing(entry('s1'));
    const b = parseKeyRing(entry('s2'));
    persistExtraKeys([...a, ...b], configured, env);
    expect(removeExtraKeys(a, env)).toBe(1);
    expect(loadExtraKeys(extraKeysPath(env)).map((k) => k.id)).toEqual(['s2']);
    expect(removeExtraKeys(undefined, env)).toBe(1);
    expect(existsSync(extraKeysPath(env))).toBe(false);
    expect(removeExtraKeys(undefined, env)).toBe(0);
  });

  it('loadKeyRing keeps the configured key first and appends the additional ones', () => {
    const spec = entry('cur');
    const src = parseKeyRing(entry('src'));
    persistExtraKeys(src, parseKeyRing(spec), env);
    const ring = loadKeyRing(spec, env);
    expect(ring.map((k) => k.id)).toEqual(['cur', 'src']);
    // An extra entry with the id of the configured key is a further candidate, never the encryption key.
    writeFileSync(extraKeysPath(env), `cur:${randomBytes(32).toString('base64')}\n`);
    expect(loadKeyRing(spec, env).map((k) => k.id)).toEqual(['cur', 'cur']);
  });

  it('the reloading box picks up a foreign key that shares the id of the configured one (auth failure, no unknown id)', () => {
    const spec = entry('k1');
    const foreignSpec = entry('k1');
    const envelope = createSecretBox(parseKeyRing(foreignSpec)).encryptJson({ pin: '1' }, 'ctx');
    const box = createReloadingSecretBox(spec, env);
    expect(() => box.decryptJson(envelope, 'ctx')).toThrow(SecretBoxError);
    persistExtraKeys(parseKeyRing(foreignSpec), parseKeyRing(spec), env);
    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;
    try {
      expect(box.decryptJson(envelope, 'ctx')).toEqual({ pin: '1' });
    } finally {
      Date.now = realNow;
    }
    expect(box.encrypt('x', 'c').startsWith('v1.k1.')).toBe(true);
  });

  it('a broken file fails loudly and names the path, never the content', () => {
    writeFileSync(join(dir, 'broken'), 'not a key at all');
    const path = join(dir, 'broken');
    expect(() => loadExtraKeys(path)).toThrow(/not a valid key file/);
    try {
      loadExtraKeys(path);
    } catch (err) {
      expect((err as Error).message).toContain(path);
      expect((err as Error).message).not.toContain('not a key at all');
    }
  });

  it('the reloading box decrypts source-key envelopes after the file appears, always encrypts with the configured key', () => {
    const sourceSpec = entry('src');
    const sourceBox = createSecretBox(parseKeyRing(sourceSpec));
    const envelope = sourceBox.encryptJson({ pin: '4711' }, 'ctx');
    const spec = entry('cur');
    const box = createReloadingSecretBox(spec, env);
    expect(() => box.decryptJson(envelope, 'ctx')).toThrow(SecretBoxError);
    persistExtraKeys(parseKeyRing(sourceSpec), parseKeyRing(spec), env);
    // The throttle may have swallowed the first reload attempt: wait it out.
    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;
    try {
      expect(box.decryptJson(envelope, 'ctx')).toEqual({ pin: '4711' });
    } finally {
      Date.now = realNow;
    }
    expect(box.activeKeyId).toBe('cur');
    expect(box.encrypt('x', 'c').startsWith('v1.cur.')).toBe(true);
    expect(box.needsReEncryption(envelope)).toBe(true);
  });

  it('an empty file means no additional keys (logged), a truncated one is strict-fail but tolerated at startup', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    try {
      const path = join(dir, 'empty-keys');
      writeFileSync(path, '  \n');
      expect(loadExtraKeys(path)).toEqual([]);
      expect(errors.join()).toContain('is empty');

      // A truncated entry: strict loading still fails loudly ...
      const spec = entry('cur');
      const src = entry('src');
      const broken = join(dir, 'broken-keys');
      writeFileSync(broken, src.slice(0, src.length - 10));
      expect(() => loadExtraKeys(broken)).toThrow(/not a valid key file/);
      // ... persisting refuses to overwrite it (the keys inside could be lost) ...
      const brokenEnv = { TIX_EXTRA_KEYS_FILE: broken };
      expect(() =>
        persistExtraKeys(parseKeyRing(entry('n')), parseKeyRing(spec), brokenEnv),
      ).toThrow(/not a valid key file/);
      expect(readFileSync(broken, 'utf8')).toBe(src.slice(0, src.length - 10));
      // ... but the process start (key ring + reloading box) must not crash: configured keys only.
      expect(loadKeyRing(spec, brokenEnv).map((k) => k.id)).toEqual(['cur']);
      const box = createReloadingSecretBox(spec, brokenEnv);
      expect(box.decrypt(box.encrypt('hello', 'c'), 'c')).toBe('hello');
      const foreign = createSecretBox(parseKeyRing(src)).encrypt('x', 'c');
      expect(() => box.decrypt(foreign, 'c')).toThrow(
        /Unknown encryption key id.*not a valid key file/,
      );
      expect(errors.join()).toContain('Continuing with the configured APP_ENCRYPTION_KEYS only');
    } finally {
      spy.mockRestore();
    }
  });

  it('writes via a unique exclusive temp file, leaves no temp behind and never follows a planted temp symlink', () => {
    const configured = parseKeyRing(entry('cur'));
    const file = extraKeysPath(env);
    persistExtraKeys(parseKeyRing(entry('s1')), configured, env);
    persistExtraKeys(parseKeyRing(entry('s2')), configured, env);
    expect(readdirSync(dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // A predictable legacy name (`<file>.<pid>.tmp`) planted as a symlink is not followed.
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'keep me');
    try {
      symlinkSync(victim, `${file}.${process.pid}.tmp`);
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    persistExtraKeys(parseKeyRing(entry('s3')), configured, env);
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(loadExtraKeys(file).map((k) => k.id)).toEqual(['s1', 's2', 's3']);
  });

  it('formatKeyRingText round-trips', () => {
    const ring = parseKeyRing(`${entry('a')},${entry('b')}`);
    const back = parseKeyRingText(formatKeyRingText(ring));
    expect(back.map((k) => [k.id, k.key.toString('hex')])).toEqual(
      ring.map((k) => [k.id, k.key.toString('hex')]),
    );
  });
});
