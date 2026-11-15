/** Audit log list/filter/export against real PostgreSQL (throw-away database). */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { adminUsers, auditLogs, createDb, loadRootEnv, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_EXPORT_MAX_ROWS, listAuditLogs, listAuditLogsForExport } from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('audit log (integration)', () => {
  const dbName = `tix_audit_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let userId: string;

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
    const [u] = await handle.db
      .insert(adminUsers)
      .values({ email: 'boss@example.org', displayName: 'Boss', roles: ['SUPER_ADMIN'] })
      .returning({ id: adminUsers.id });
    userId = u!.id;
    const rows: (typeof auditLogs.$inferInsert)[] = Array.from({ length: 30 }, (_, i) => ({
      actorType: 'ADMIN',
      actorUserId: userId,
      action: i % 2 ? 'order.refund' : 'settings.update',
      entityType: i % 2 ? 'order' : 'setting',
      entityId: `ent_${String(i).padStart(2, '0')}`,
      changes: { password: 'x' },
      createdAt: new Date(Date.UTC(2026, 0, 1 + i, 12)),
    }));
    rows.push({
      actorType: 'SYSTEM',
      actorUserId: null,
      action: 'sweeper.run',
      entityType: 'job',
      entityId: '100%_x',
      changes: null,
      createdAt: new Date(Date.UTC(2026, 1, 20)),
    });
    await handle.db.insert(auditLogs).values(rows);
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('pages newest first with a total', async () => {
    const p1 = await listAuditLogs(handle, {}, { page: 1, pageSize: 25 });
    expect(p1.total).toBe(31);
    expect(p1.rows).toHaveLength(25);
    expect(p1.rows[0]?.action).toBe('sweeper.run');
    const p2 = await listAuditLogs(handle, {}, { page: 2, pageSize: 25 });
    expect(p2.rows).toHaveLength(6);
  });

  it('filters by prefix, entity type, actor and date range', async () => {
    expect((await listAuditLogs(handle, { actionPrefix: 'order.' })).total).toBe(15);
    expect((await listAuditLogs(handle, { entityType: 'setting' })).total).toBe(15);
    expect((await listAuditLogs(handle, { actorUserId: userId })).total).toBe(30);
    const range = await listAuditLogs(handle, {
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2026, 0, 4)),
    });
    expect(range.total).toBe(3);
  });

  it('free text matches action, entity id and actor e-mail; wildcards are literal', async () => {
    expect((await listAuditLogs(handle, { q: 'ent_05' })).total).toBe(1);
    expect((await listAuditLogs(handle, { q: 'BOSS@example' })).total).toBe(30);
    expect((await listAuditLogs(handle, { q: 'sweeper' })).total).toBe(1);
    expect((await listAuditLogs(handle, { q: '%' })).total).toBe(1);
    expect((await listAuditLogs(handle, { q: '_' })).total).toBe(31);
  });

  it('exports with the actor e-mail and a row cap constant', async () => {
    const { rows, truncated } = await listAuditLogsForExport(handle, { actionPrefix: 'order.' });
    expect(rows).toHaveLength(15);
    expect(truncated).toBe(false);
    expect(rows[0]?.actorEmail).toBe('boss@example.org');
    expect(AUDIT_EXPORT_MAX_ROWS).toBe(10_000);
  });
});
