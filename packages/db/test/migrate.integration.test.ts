/**
 * Migration runner: pending detection, pre-update hook and lock-timeout retry against a real
 * PostgreSQL (throwaway database; TEST_DATABASE_URL must allow CREATE DATABASE).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRootEnv } from '../src/env';
import { readMigrationState, runMigrations } from '../src/migrate';

loadRootEnv();
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = ADMIN_URL ? describe : describe.skip;

/** Writes a migrations folder with the given SQL files (idx order, ascending `when`). */
function migrationsFolder(root: string, name: string, files: string[]): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const entries = files.map((_sql, idx) => ({
    idx,
    version: '7',
    when: 1_700_000_000_000 + idx * 1000,
    tag: `000${idx}_m${idx}`,
    breakpoints: true,
  }));
  files.forEach((sql, idx) => writeFileSync(join(dir, `${entries[idx]!.tag}.sql`), sql));
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  return dir;
}

run('migration runner', () => {
  const dbName = `tix_mig_${randomBytes(4).toString('hex')}`;
  const root = mkdtempSync(join(tmpdir(), 'tix-mig-'));
  let admin: pg.Client;
  let url: string;

  const withClient = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const quiet = () => undefined;
  const hasColumn = (column: string) =>
    withClient(async (c) => {
      const res = await c.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 't' AND column_name = $1",
        [column],
      );
      return res.rowCount === 1;
    });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    url = u.toString();
  });
  afterAll(async () => {
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
    rmSync(root, { recursive: true, force: true });
  });

  it('detects fresh, up-to-date and pending the way drizzle does, and calls the hook only for pending upgrades', async () => {
    const v1 = migrationsFolder(root, 'v1', ['CREATE TABLE t (id int);']);
    const v2 = migrationsFolder(root, 'v2', [
      'CREATE TABLE t (id int);',
      'ALTER TABLE t ADD COLUMN c int;',
    ]);
    const seen: string[][] = [];
    const hook = async (state: { pending: { tag: string }[] }) => {
      seen.push(state.pending.map((p) => p.tag));
    };

    expect((await withClient((c) => readMigrationState(c, v1))).fresh).toBe(true);
    // Fresh installation: nothing to protect, hook not called.
    await runMigrations({
      connectionString: url,
      migrationsFolder: v1,
      log: quiet,
      beforeApply: hook,
    });
    expect(seen).toEqual([]);
    // Up to date: not called either.
    await runMigrations({
      connectionString: url,
      migrationsFolder: v1,
      log: quiet,
      beforeApply: hook,
    });
    expect(seen).toEqual([]);
    expect(await withClient((c) => readMigrationState(c, v1))).toMatchObject({
      fresh: false,
      applied: 1,
      pending: [],
    });
    expect((await withClient((c) => readMigrationState(c, v2))).pending.map((p) => p.tag)).toEqual([
      '0001_m1',
    ]);

    // A throwing hook aborts before anything is applied.
    await expect(
      runMigrations({
        connectionString: url,
        migrationsFolder: v2,
        log: quiet,
        beforeApply: async () => {
          throw new Error('backup failed');
        },
      }),
    ).rejects.toThrow('backup failed');
    expect(await hasColumn('c')).toBe(false);

    await runMigrations({
      connectionString: url,
      migrationsFolder: v2,
      log: quiet,
      beforeApply: hook,
    });
    expect(seen).toEqual([['0001_m1']]);
    expect((await withClient((c) => readMigrationState(c, v2))).pending).toEqual([]);
  });

  it('retries after a lock timeout, names the blocking table and gives up with a clear message', async () => {
    const v3 = migrationsFolder(root, 'v3', [
      'CREATE TABLE t (id int);',
      'ALTER TABLE t ADD COLUMN c int;',
      'ALTER TABLE t ADD COLUMN d int;',
    ]);
    const blocker = new pg.Client({ connectionString: url, application_name: 'test-blocker' });
    await blocker.connect();
    const logs: string[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE t IN ACCESS EXCLUSIVE MODE');
      // Released after the first attempt timed out: the retry succeeds.
      const release = setTimeout(() => void blocker.query('ROLLBACK'), 700);
      await runMigrations({
        connectionString: url,
        migrationsFolder: v3,
        log: (m) => logs.push(m),
        lockTimeoutMs: 300,
        retryDelayMs: 100,
        lockRetries: 5,
      });
      clearTimeout(release);
      expect(logs.some((m) => /another session holds a lock on a table/.test(m))).toBe(true);
      expect(logs.join('\n')).toContain('test-blocker');
      expect(logs.join('\n')).toMatch(/\bt \(held by/);
      expect(await hasColumn('d')).toBe(true);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }

    const v4 = migrationsFolder(root, 'v4', [
      'CREATE TABLE t (id int);',
      'ALTER TABLE t ADD COLUMN c int;',
      'ALTER TABLE t ADD COLUMN d int;',
      'ALTER TABLE t ADD COLUMN e int;',
    ]);
    const holder = new pg.Client({ connectionString: url, application_name: 'test-holder' });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE t IN ACCESS EXCLUSIVE MODE');
      await expect(
        runMigrations({
          connectionString: url,
          migrationsFolder: v4,
          log: quiet,
          lockTimeoutMs: 200,
          retryDelayMs: 50,
          lockRetries: 2,
        }),
      ).rejects.toThrow(/gave up after 2 attempts: another session holds a lock/);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
    // Nothing was half applied, and a later run succeeds.
    expect(await hasColumn('e')).toBe(false);
    await runMigrations({ connectionString: url, migrationsFolder: v4, log: quiet });
    expect(await hasColumn('e')).toBe(true);
  });

  it('the real migrations still apply on an empty database (default timeouts)', async () => {
    const real = resolve(__dirname, '../migrations');
    const name = `${dbName}_real`;
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      const u = new URL(ADMIN_URL!);
      u.pathname = `/${name}`;
      await runMigrations({ connectionString: u.toString(), migrationsFolder: real, log: quiet });
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });
});
