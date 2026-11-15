import {
  createSecretBox,
  keyFingerprint,
  type SecretBox,
  type SecretBoxKey,
} from '@tix/shared/server';
import { sql, type SQL } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { SECRET_COLUMNS, type SecretColumn } from './registry';

/**
 * Moves every registered secret that is NOT readable with the primary key (those encrypted with an
 * additional / foreign key, or a rotated-out operator key) to the primary key.
 *
 * Properties:
 *  - idempotent and resumable without a cursor: values the primary key already opens are skipped,
 *    so a second run only touches what is left;
 *  - batches of `batchSize` rows, one transaction each, `FOR UPDATE` row locks; a failure rolls the
 *    current batch back and leaves everything readable (earlier batches are complete and valid);
 *  - every new envelope is decrypted again with the PRIMARY key only and compared before and after
 *    the (compare-and-swap) update;
 *  - rows no known key opens are reported (table + primary key only) and left untouched;
 *  - values are never logged or returned.
 */
export interface ReEncryptTableResult {
  /** Registry id. */
  id: string;
  reEncrypted: number;
  /** Already readable with the primary key. */
  skipped: number;
  undecryptable: number;
}

export interface ReEncryptResult {
  tables: ReEncryptTableResult[];
  /** Table + primary key of the first rows no known key opens (never values; capped, the counts are exact). */
  undecryptable: { id: string; pk: string }[];
  /** Rows the final verification pass found that the primary key cannot open. */
  remainingForeign: number;
  /** Nothing left that needs another key: the additional keys can be removed. */
  complete: boolean;
}

/** The list of unreadable rows is capped (the per-table counts stay exact). */
export const MAX_REPORTED_ROWS = 50;

type Db = CoreContext['db'];
type Executor = Pick<Db, 'execute'>;

const ident = (name: string) => sql.identifier(name);
const valueExpr = (c: SecretColumn): SQL =>
  c.jsonKey ? sql`${ident(c.column)}->>${c.jsonKey}` : sql`${ident(c.column)}`;
const presentFilter = (c: SecretColumn): SQL =>
  c.jsonKey
    ? sql`jsonb_typeof(${ident(c.column)}->${c.jsonKey}) = 'string'`
    : sql`${ident(c.column)} IS NOT NULL`;
// A single-column key is used as is (the primary-key index serves ORDER BY / > / =); a text cast
// would force a scan per row. Composite keys (none today) fall back to their text form.
const pkExpr = (c: SecretColumn): SQL =>
  c.primaryKey.length === 1
    ? sql`${ident(c.primaryKey[0]!)}`
    : sql.join(
        c.primaryKey.map((k) => sql`${ident(k)}::text`),
        sql` || '|' || `,
      );
const keyOf = (pk: readonly string[]) => pk.join('|');
const pkWhere = (c: SecretColumn, pk: readonly string[]): SQL =>
  c.primaryKey.length === 1
    ? sql`${ident(c.primaryKey[0]!)} = ${pk[0]!}`
    : sql.join(
        c.primaryKey.map((k, i) => sql`${ident(k)}::text = ${pk[i]!}`),
        sql` AND `,
      );

interface Row {
  pk: string[];
  value: string;
}

async function readBatch(
  db: Executor,
  c: SecretColumn,
  after: string | null,
  limit: number,
  lock: boolean,
): Promise<Row[]> {
  const pkCols = sql.join(
    c.primaryKey.map((k, i) => sql`${ident(k)}::text AS ${ident(`pk${i}`)}`),
    sql`, `,
  );
  const result = await db.execute<Record<string, string>>(sql`
    SELECT ${pkCols}, ${valueExpr(c)} AS value
    FROM ${ident(c.table)}
    WHERE ${presentFilter(c)} ${after === null ? sql`` : sql`AND ${pkExpr(c)} > ${after}`}
    ORDER BY ${pkExpr(c)}
    LIMIT ${limit}
    ${lock ? sql`FOR UPDATE` : sql``}
  `);
  return result.rows.map((r) => ({
    pk: c.primaryKey.map((_, i) => String(r[`pk${i}`])),
    value: String(r.value),
  }));
}

async function writeValue(
  db: Executor,
  c: SecretColumn,
  pk: readonly string[],
  oldValue: string,
  newValue: string,
): Promise<boolean> {
  const set = c.jsonKey
    ? sql`${ident(c.column)} = jsonb_set(${ident(c.column)}, ARRAY[${c.jsonKey}]::text[], to_jsonb(${newValue}::text))`
    : sql`${ident(c.column)} = ${newValue}`;
  const result = await db.execute(sql`
    UPDATE ${ident(c.table)} SET ${set}
    WHERE ${pkWhere(c, pk)} AND ${valueExpr(c)} = ${oldValue}
  `);
  return (result.rowCount ?? 0) === 1;
}

async function readOne(
  db: Executor,
  c: SecretColumn,
  pk: readonly string[],
): Promise<string | null> {
  const result = await db.execute<{ value: string | null }>(
    sql`SELECT ${valueExpr(c)} AS value FROM ${ident(c.table)} WHERE ${pkWhere(c, pk)}`,
  );
  return result.rows[0]?.value ?? null;
}

export interface ReEncryptOptions {
  /** The key new values are encrypted with (first key of the configured ring). */
  primary: SecretBoxKey;
  /** Every key the values may currently be encrypted with. */
  allKeys: readonly SecretBoxKey[];
  batchSize?: number;
  /** Called before each table (progress panel). */
  onTable?: (id: string) => void | Promise<void>;
  /** Entries to process (defaults to the whole registry). */
  columns?: readonly SecretColumn[];
}

export async function reEncryptSecrets(
  ctx: Pick<CoreContext, 'db'>,
  options: ReEncryptOptions,
): Promise<ReEncryptResult> {
  const columns = options.columns ?? SECRET_COLUMNS;
  const batchSize = options.batchSize ?? 200;
  const primary: SecretBox = createSecretBox([options.primary]);
  const all: SecretBox = createSecretBox([...options.allKeys]);
  const tables: ReEncryptTableResult[] = [];
  const undecryptable: ReEncryptResult['undecryptable'] = [];

  for (const c of columns) {
    await options.onTable?.(c.id);
    const result: ReEncryptTableResult = { id: c.id, reEncrypted: 0, skipped: 0, undecryptable: 0 };
    let after: string | null = null;
    for (;;) {
      const page: { last: string | null; full: boolean } = { last: null, full: false };
      await ctx.db.transaction(async (tx) => {
        const rows = await readBatch(tx, c, after, batchSize, true);
        page.full = rows.length >= batchSize;
        for (const row of rows) {
          page.last = keyOf(row.pk);
          const context = c.context(row.pk);
          try {
            primary.decrypt(row.value, context);
            result.skipped += 1;
            continue;
          } catch {
            /* not readable with the primary key: try all keys */
          }
          let plain: string;
          try {
            plain = all.decrypt(row.value, context);
          } catch {
            result.undecryptable += 1;
            if (undecryptable.length < MAX_REPORTED_ROWS) {
              undecryptable.push({ id: c.id, pk: keyOf(row.pk) });
            }
            continue;
          }
          const fresh = primary.encrypt(plain, context);
          if (primary.decrypt(fresh, context) !== plain) {
            throw new Error(`Re-encryption verification failed for ${c.id}`);
          }
          if (!(await writeValue(tx, c, row.pk, row.value, fresh))) {
            throw new Error(`A locked row of ${c.id} changed`);
          }
          // Read back inside the transaction: what is stored must open with the primary key.
          const stored = await readOne(tx, c, row.pk);
          if (stored === null || primary.decrypt(stored, context) !== plain) {
            throw new Error(`Re-encryption read-back failed for ${c.id}`);
          }
          result.reEncrypted += 1;
        }
      });
      if (!page.full || page.last === null) break;
      after = page.last;
    }
    tables.push(result);
  }

  // Verification pass, independent of the work above: nothing may need another key any more.
  let remainingForeign = 0;
  for (const c of columns) {
    let after: string | null = null;
    for (;;) {
      const rows = await readBatch(ctx.db, c, after, 500, false);
      for (const row of rows) {
        try {
          primary.decrypt(row.value, c.context(row.pk));
        } catch {
          remainingForeign += 1;
        }
      }
      if (rows.length < 500) break;
      after = keyOf(rows[rows.length - 1]!.pk);
    }
  }
  return {
    tables,
    undecryptable,
    remainingForeign,
    // Rows nobody can open are counted in `remainingForeign` too (the primary cannot open them).
    complete: remainingForeign === 0,
  };
}

export interface SecretsReadability {
  /** Stored secrets none of `ring`'s keys opens. */
  unreadable: number;
  tables: { id: string; unreadable: number }[];
}

/**
 * Read-only verification pass: how many registered secrets can NOT be opened with `ring`? Used after
 * a restore (the restored values may sit under keys this system does not have) and by the probe.
 */
export async function verifySecretsReadable(
  ctx: Pick<CoreContext, 'db'>,
  ring: readonly SecretBoxKey[],
  columns: readonly SecretColumn[] = SECRET_COLUMNS,
): Promise<SecretsReadability> {
  const box = createSecretBox([...ring]);
  const tables: SecretsReadability['tables'] = [];
  let unreadable = 0;
  for (const c of columns) {
    let count = 0;
    let after: string | null = null;
    for (;;) {
      const rows = await readBatch(ctx.db, c, after, 500, false);
      for (const row of rows) {
        try {
          box.decrypt(row.value, c.context(row.pk));
        } catch {
          count += 1;
        }
      }
      if (rows.length < 500) break;
      after = keyOf(rows[rows.length - 1]!.pk);
    }
    if (count > 0) tables.push({ id: c.id, unreadable: count });
    unreadable += count;
  }
  return { unreadable, tables };
}

/** Longest list of key fingerprints written into a manifest. */
export const MAX_SECRET_KEY_FINGERPRINTS = 20;

/**
 * Fingerprints (`<keyId>:<8 hex>`, see `keyFingerprint`) of the keys that open the stored secrets,
 * from ONE sample envelope per registry column and key id (cheap: no full decryption pass). A key
 * id whose sample no key of `ring` opens is reported as `<keyId>:unreadable`. Stored in the backup
 * manifest so a later restore / key removal can tell which keys the backup's secrets depend on.
 * Sample based: two different keys under the same id inside one column are not told apart.
 */
export async function collectSecretKeyFingerprints(
  ctx: Pick<CoreContext, 'db'>,
  ring: readonly SecretBoxKey[],
  columns: readonly SecretColumn[] = SECRET_COLUMNS,
  /** A table / column that does not exist (database of an older version) is skipped. */
  options: { tolerateMissing?: boolean } = {},
): Promise<string[]> {
  const found = new Set<string>();
  for (const c of columns) {
    const pkCols = sql.join(
      c.primaryKey.map((k, i) => sql`${ident(k)}::text AS ${ident(`pk${i}`)}`),
      sql`, `,
    );
    let result: { rows: Record<string, string>[] };
    try {
      result = await ctx.db.execute<Record<string, string>>(sql`
        SELECT DISTINCT ON (split_part(s.value, '.', 2)) s.*
        FROM (SELECT ${pkCols}, ${valueExpr(c)} AS value FROM ${ident(c.table)} WHERE ${presentFilter(c)}) s
        ORDER BY split_part(s.value, '.', 2), s.pk0
      `);
    } catch (err) {
      const code =
        (err as { cause?: { code?: string }; code?: string }).cause?.code ??
        (err as { code?: string }).code;
      if (options.tolerateMissing && (code === '42P01' || code === '42703')) continue;
      throw err;
    }
    for (const r of result.rows) {
      const value = String(r.value);
      const keyId = value.split('.')[1] ?? '';
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(keyId)) continue;
      const pk = c.primaryKey.map((_, i) => String(r[`pk${i}`]));
      const opener = ring.find((key) => {
        try {
          createSecretBox([key]).decrypt(value, c.context(pk));
          return true;
        } catch {
          return false;
        }
      });
      found.add(opener ? `${opener.id}:${keyFingerprint(opener)}` : `${keyId}:unreadable`);
    }
  }
  return [...found].sort().slice(0, MAX_SECRET_KEY_FINGERPRINTS);
}
