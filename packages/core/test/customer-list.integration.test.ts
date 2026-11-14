/**
 * Admin customer list (search, paging, sorting) against real PostgreSQL (throw-away database).
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, customers, loadRootEnv, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listCustomers } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('customer list (integration)', () => {
  const dbName = `tix_custlist_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 4 });
    const rows = Array.from({ length: 30 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return {
        email: `person${n}@example.org`,
        firstName: 'Person',
        lastName: `Name${n}`,
        phone: i === 6 ? '+49 6134 555 007' : null,
      };
    });
    await handle.db.insert(customers).values(rows);
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('pages on the server and reports the total', async () => {
    const first = await listCustomers(handle, { page: 1, pageSize: 25, sort: 'name', dir: 'asc' });
    expect(first.total).toBe(30);
    expect(first.rows).toHaveLength(25);
    const second = await listCustomers(handle, { page: 2, pageSize: 25, sort: 'name', dir: 'asc' });
    expect(second.rows).toHaveLength(5);
    expect(second.rows[0]?.lastName).toBe('Name26');
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(30);
  });

  it('sorts by name in both directions', async () => {
    const asc = await listCustomers(handle, { pageSize: 10, sort: 'name', dir: 'asc' });
    expect(asc.rows[0]?.lastName).toBe('Name01');
    const desc = await listCustomers(handle, { pageSize: 10, sort: 'name', dir: 'desc' });
    expect(desc.rows[0]?.lastName).toBe('Name30');
  });

  it('searches e-mail, phone and name case-insensitively', async () => {
    expect((await listCustomers(handle, { q: 'PERSON12@' })).rows.map((r) => r.lastName)).toEqual([
      'Name12',
    ]);
    expect((await listCustomers(handle, { q: '555 007' })).rows.map((r) => r.lastName)).toEqual([
      'Name07',
    ]);
    expect((await listCustomers(handle, { q: 'name2' })).total).toBe(10);
    expect((await listCustomers(handle, { q: '100%' })).total).toBe(0);
  });

  it('clamps page size and page, and ignores unknown sort keys', async () => {
    const huge = await listCustomers(handle, { pageSize: 100_000 });
    expect(huge.rows.length).toBe(30);
    const neg = await listCustomers(handle, { page: -3, pageSize: 5 });
    expect(neg.rows).toHaveLength(5);
    const bad = await listCustomers(handle, { sort: 'nope' as never });
    expect(bad.total).toBe(30);
  });

  it('has trigram indexes for the admin search', async () => {
    const result = await handle.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'customers' AND indexname LIKE '%trgm%'`,
    );
    const names = (result as unknown as { rows?: { indexname: string }[] }).rows?.map(
      (r) => r.indexname,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'customers_email_trgm_idx',
        'customers_phone_trgm_idx',
        'customers_name_rev_trgm_idx',
      ]),
    );
  });
});
