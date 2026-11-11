import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PgClient } from '@tix/db';
import { BACKUP_COUNT_TABLES, type MigrationInfo } from './manifest';

/* PostgreSQL helpers of the backup module: command line tools (pg_dump / pg_restore / psql),
 * server-side snapshot, row counts, migration level and session termination. */

export interface PgBinaries {
  dump: string;
  restore: string;
  psql: string;
}
export const DEFAULT_PG_BINARIES: PgBinaries = {
  dump: 'pg_dump',
  restore: 'pg_restore',
  psql: 'psql',
};

/** libpq environment for a connection URL (password never appears on a command line). */
export function pgEnv(
  connectionString: string,
  applicationName: string,
  database?: string,
): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  // Only what the tools need: no application secrets (session keys, S3 keys …) leak to them.
  const env = {
    PATH: process.env.PATH,
    PGHOST: decodeURIComponent(url.hostname),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database ?? decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGAPPNAME: applicationName,
  } as unknown as NodeJS.ProcessEnv;
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

export function databaseName(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
}

/** Connection string of the same server with another database name. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

export class PgToolError extends Error {
  override name = 'PgToolError';
}

/**
 * Keeps only the ERROR / FATAL lines of a tool's stderr: CONTEXT, DETAIL, LINE and "Command was"
 * lines can contain row data (personal data) and must not reach logs or the UI.
 */
export function errorLinesOnly(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => /\b(ERROR|FATAL|error|fatal)\b/.test(line))
    .filter((line) => !/^\s*(CONTEXT|DETAIL|HINT|LINE \d+|Command was)\b/.test(line))
    .map((line) => line.slice(0, 300))
    .slice(0, 5)
    .join(' | ');
}

function captureStderr(child: ChildProcess): () => string {
  let tail = '';
  child.stderr?.on('data', (d: Buffer) => {
    tail = (tail + d.toString('utf8')).slice(-8_000);
  });
  return () => errorLinesOnly(tail);
}

function exited(child: ChildProcess, tool: string, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        new PgToolError(
          err.code === 'ENOENT'
            ? `${tool} is not installed (the worker image needs the PostgreSQL client tools)`
            : `${tool} failed to start: ${err.message}`,
        ),
      ),
    );
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new PgToolError(`${tool} failed (${code ?? signal}): ${stderr()}`));
    });
  });
}

/** `pg_dump -Fc` as a byte stream; throws after the last chunk when the tool failed. */
export async function* pgDumpStream(
  binaries: PgBinaries,
  connectionString: string,
  snapshot?: string,
): AsyncGenerator<Buffer> {
  // `retained` (erasure ledger) is never part of a backup; large objects are not used by the app.
  const args = [
    '-Fc',
    '--no-owner',
    '--no-privileges',
    '--exclude-schema=retained',
    '--no-large-objects',
  ];
  if (snapshot) args.push(`--snapshot=${snapshot}`);
  const child = spawn(binaries.dump, args, {
    env: pgEnv(connectionString, 'tix-backup'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = exited(child, 'pg_dump', captureStderr(child));
  done.catch(() => undefined); // surfaced below
  try {
    for await (const chunk of child.stdout!) yield chunk as Buffer;
    await done;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

/** Major version printed by `<tool> --version`. */
export async function toolMajorVersion(binary: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.once('error', () => resolve(null));
    child.once('close', () => {
      const match = /(\d+)(?:\.\d+)*/.exec(out.replace(/^[^\d]*/, ''));
      resolve(match ? Number(match[1]) : null);
    });
  });
}

export class PgRestoreError extends Error {
  override name = 'PgRestoreError';
  constructor(
    message: string,
    /** COMMIT was already sent: the outcome is unknown, the database may have been replaced. */
    readonly commitSent: boolean,
  ) {
    super(message);
  }
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * SQL that keeps number counters and sequences monotonic inside the restore transaction:
 * every counter / sequence ends at GREATEST(live, restored) (GoBD: numbers are never reused).
 */
export function carryForwardSql(live: {
  counters: ReadonlyMap<string, number>;
  sequences: ReadonlyMap<string, number>;
}): string {
  const lines: string[] = [];
  for (const [scope, value] of live.counters) {
    lines.push(
      `INSERT INTO public.number_sequences (scope, last_value) VALUES (${literal(scope)}, ${Math.trunc(value)}) ON CONFLICT (scope) DO UPDATE SET last_value = GREATEST(public.number_sequences.last_value, EXCLUDED.last_value), updated_at = now();`,
    );
  }
  for (const [name, value] of live.sequences) {
    const qualified = `public.${'"' + name.replaceAll('"', '""') + '"'}`;
    lines.push(
      `DO $$ BEGIN IF to_regclass(${literal(qualified)}) IS NOT NULL THEN PERFORM setval(${literal(qualified)}, GREATEST(${Math.trunc(value)}, coalesce((SELECT last_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename = ${literal(name)}), 0))); END IF; END $$;`,
    );
  }
  // Scanner devices must not keep stale data: a new sync epoch makes every device wipe its local
  // tickets and resync (xids and versions of the restored database are unrelated to the old ones).
  // Restored tickets carry xids of the old cluster: the sync trigger rewrites sync_xid with the xid
  // of this restore transaction, so they are not re-delivered by every later sync run.
  lines.push(
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'sync_xid') THEN UPDATE public.tickets SET sync_xid = '0'::xid8; END IF; END $$;",
  );
  lines.push(
    "DO $$ BEGIN IF to_regclass('public.scanner_sync_state') IS NOT NULL THEN UPDATE public.scanner_sync_state SET sync_epoch = gen_random_uuid()::text; END IF; END $$;",
  );
  return lines.join('\n');
}

/**
 * Replaces the public schema with a custom-format dump (stdin):
 * `pg_restore -f -` renders SQL which one psql session executes inside an explicit
 * transaction we control: BEGIN; DROP/CREATE SCHEMA; <dump>; <carry-forward SQL>; COMMIT.
 * COMMIT is only sent after pg_restore exited 0 and `beforeCommit` succeeded – psql EOF never
 * commits. On any failure psql is killed (rollback) and the live database stays untouched.
 * (`--clean` would leave tables that exist only in the newer live schema.)
 */
export async function pgRestoreFromStream(
  binaries: PgBinaries,
  connectionString: string,
  dump: AsyncIterable<Uint8Array>,
  options: {
    applicationName: string;
    /** SQL executed in the same transaction after the dump (counters, sequences). */
    carryForward?: string;
    /** Called right before COMMIT (e.g. to set the durable RESTORE_INCOMPLETE marker). */
    beforeCommit?: () => Promise<void>;
  },
): Promise<void> {
  const env = pgEnv(connectionString, options.applicationName);
  const restore = spawn(binaries.restore, ['--no-owner', '--no-privileges', '-f', '-'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const psql = spawn(binaries.psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const restoreDone = exited(restore, 'pg_restore', captureStderr(restore));
  const psqlDone = exited(psql, 'psql', captureStderr(psql));
  restoreDone.catch(() => undefined);
  psqlDone.catch(() => undefined);
  let commitSent = false;
  let seen = '';
  const ready = new Promise<void>((resolve) => {
    psql.stdout!.on('data', (d: Buffer) => {
      seen = (seen + d.toString('utf8')).slice(-200);
      if (seen.includes('TIX_READY')) resolve();
    });
  });
  ready.catch(() => undefined);
  try {
    psql.stdin!.on('error', () => undefined);
    restore.stdin!.on('error', () => undefined);
    psql.stdin!.write('BEGIN;\nDROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n');
    // end:false – psql must not see EOF (and thus never commit) just because pg_restore ended.
    restore.stdout!.pipe(psql.stdin!, { end: false });
    // A tool settling while we still feed data means it died (a rejection is thrown below).
    const earlyExit = Promise.race([restoreDone, psqlDone]);
    earlyExit.catch(() => undefined);
    for await (const chunk of dump) {
      if (!restore.stdin!.write(chunk)) {
        await Promise.race([
          new Promise<void>((resolve) => restore.stdin!.once('drain', resolve)),
          earlyExit,
        ]);
      }
    }
    restore.stdin!.end();
    // pg_restore must exit 0; a dying psql rejects the race instead of hanging the restore.
    await Promise.race([restoreDone, earlyExit]);
    await restoreDone;
    if (psql.exitCode !== null) await psqlDone; // psql died on its own: its error is the cause
    // Handshake: psql runs statements in order and stops at the first error (ON_ERROR_STOP), so
    // the marker below appears only when the whole dump and the carry-forward SQL succeeded.
    psql.stdin!.write(`\n${options.carryForward ?? ''}\n\\echo TIX_READY\n`);
    const endedEarly = psqlDone.then(() => {
      throw new Error('psql ended before the dump was fully applied');
    });
    endedEarly.catch(() => undefined);
    await Promise.race([ready, endedEarly]);
    await options.beforeCommit?.();
    commitSent = true;
    psql.stdin!.write('COMMIT;\n');
    psql.stdin!.end();
    await psqlDone;
  } catch (err) {
    const psqlDiedAlone = psql.exitCode !== null && psql.exitCode !== 0;
    const restoreDiedAlone = restore.exitCode !== null && restore.exitCode !== 0;
    for (const c of [restore, psql]) if (c.exitCode === null) c.kill('SIGKILL');
    const [restored, executed] = await Promise.allSettled([restoreDone, psqlDone]);
    // Report the real cause: psql's SQL error only when psql failed by itself, pg_restore's error
    // when it failed by itself, otherwise the original error (e.g. decryption of the archive).
    // A tool that we killed ourselves reports "SIGKILL", which is not the cause.
    let cause: unknown = err;
    if (psqlDiedAlone && executed.status === 'rejected') cause = executed.reason;
    else if (restoreDiedAlone && restored.status === 'rejected') cause = restored.reason;
    throw new PgRestoreError(cause instanceof Error ? cause.message : String(cause), commitSent);
  }
}

/** Current value of every public sequence that was used (for the carry-forward). */
export async function readPublicSequences(
  client: Pick<PgClient, 'query'>,
): Promise<Map<string, number>> {
  const res = await client.query<{ sequencename: string; last_value: string }>(
    "SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' AND last_value IS NOT NULL",
  );
  return new Map(res.rows.map((r) => [r.sequencename, Number(r.last_value)]));
}

/** Applied migrations of the database (drizzle bookkeeping table) resolved against the code's journal. */
export async function readMigrationInfo(
  client: Pick<PgClient, 'query'>,
  migrationsDir: string,
): Promise<MigrationInfo> {
  const res = await client.query<{ when: string | null; count: string }>(
    'SELECT max(created_at) AS "when", count(*) AS count FROM public.__drizzle_migrations',
  );
  const when = Number(res.rows[0]?.when ?? 0);
  const journal = await readJournal(migrationsDir);
  return {
    when,
    count: Number(res.rows[0]?.count ?? 0),
    tag: journal.find((e) => e.when === when)?.tag ?? null,
  };
}

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export async function readJournal(migrationsDir: string): Promise<JournalEntry[]> {
  const raw = await readFile(join(migrationsDir, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/** `when` of the newest migration shipped with this code. */
export async function latestCodeMigration(migrationsDir: string): Promise<JournalEntry> {
  const entries = await readJournal(migrationsDir);
  const last = entries.reduce((a, b) => (b.when > a.when ? b : a));
  return last;
}

/** Row counts (exact) of the whitelisted tables, through `client` (use one snapshot per backup). */
export async function readRowCounts(
  client: Pick<PgClient, 'query'>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BACKUP_COUNT_TABLES) {
    const res = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public."${table}"`);
    counts[table] = Number(res.rows[0]?.n ?? 0);
  }
  return counts;
}

/** Number counters (GoBD): scope → last value. */
export async function readSequenceCounters(
  client: Pick<PgClient, 'query'>,
): Promise<Map<string, number>> {
  const res = await client.query<{ scope: string; last_value: string }>(
    'SELECT scope, last_value FROM public.number_sequences',
  );
  return new Map(res.rows.map((r) => [r.scope, Number(r.last_value)]));
}

/**
 * Terminates every other session of the current database except `keepApplications`.
 * Returns the number of sessions that were terminated.
 */
export async function terminateOtherSessions(
  client: Pick<PgClient, 'query'>,
  keepApplications: readonly string[],
): Promise<number> {
  const res = await client.query<{ terminated: boolean }>(
    `SELECT pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
        AND application_name <> ALL($1::text[])`,
    [keepApplications],
  );
  return res.rows.filter((r) => r.terminated).length;
}

export async function withPgClient<T>(
  connectionString: string,
  applicationName: string,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = new PgClient({ connectionString, application_name: applicationName });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
