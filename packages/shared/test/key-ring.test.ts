import { randomBytes } from 'node:crypto';
import {
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
  parseKeyRingText,
  persistExtraKeys,
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

  it('merges identical entries and rejects the same id with different material', () => {
    const a = parseKeyRing(entry('k1'));
    expect(mergeKeyRings(a, a)).toHaveLength(1);
    const other = parseKeyRing(entry('k1'));
    expect(() => mergeKeyRings(a, other)).toThrow(/different key/);
    expect(mergeKeyRings(a, parseKeyRing(entry('k2'))).map((k) => k.id)).toEqual(['k1', 'k2']);
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

  it('rejects collisions with the configured ring and with the file, writing nothing', () => {
    const configured = parseKeyRing(entry('k1'));
    expect(() => persistExtraKeys(parseKeyRing(entry('k1')), configured, env)).toThrow(
      SecretBoxError,
    );
    expect(loadExtraKeys(extraKeysPath(env))).toEqual([]);
    persistExtraKeys(parseKeyRing(entry('s1')), configured, env);
    expect(() => persistExtraKeys(parseKeyRing(entry('s1')), configured, env)).toThrow(
      SecretBoxError,
    );
    expect(loadExtraKeys(extraKeysPath(env))).toHaveLength(1);
  });

  it('loadKeyRing keeps the configured key first and appends the additional ones', () => {
    const spec = entry('cur');
    const src = parseKeyRing(entry('src'));
    persistExtraKeys(src, parseKeyRing(spec), env);
    const ring = loadKeyRing(spec, env);
    expect(ring.map((k) => k.id)).toEqual(['cur', 'src']);
    // A colliding extra file is an error, not a silent override.
    writeFileSync(extraKeysPath(env), `cur:${randomBytes(32).toString('base64')}\n`);
    expect(() => loadKeyRing(spec, env)).toThrow(SecretBoxError);
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
