/**
 * Prometheus endpoint token: stored as an encrypted secret setting, verified in constant time.
 * Throw-away database and key prefix.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, loadRootEnv, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearMetricsToken,
  createCoreContext,
  generateMetricsToken,
  invalidateSettings,
  isMetricsEnabled,
  verifyMetricsToken,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!adminUrl || !redisUrl)('metrics token (integration)', () => {
  const dbName = `tix_mt_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;

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
    handle = createDb({ connectionString: url.toString(), poolMax: 3 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(`k1:${Buffer.alloc(32, 7).toString('base64')}`)),
    });
  });

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('is disabled until a token exists, then verifies it, then can be switched off again', async () => {
    invalidateSettings();
    expect(await isMetricsEnabled(ctx)).toBe(false);
    expect(await verifyMetricsToken(ctx, 'anything')).toBe('disabled');

    const token = await generateMetricsToken(ctx, null);
    expect(token.length).toBeGreaterThanOrEqual(24);
    invalidateSettings();
    expect(await isMetricsEnabled(ctx)).toBe(true);
    expect(await verifyMetricsToken(ctx, token)).toBe('ok');
    expect(await verifyMetricsToken(ctx, `${token}x`)).toBe('denied');
    expect(await verifyMetricsToken(ctx, 'short')).toBe('denied');
    expect(await verifyMetricsToken(ctx, null)).toBe('denied');
    expect(await verifyMetricsToken(ctx, '')).toBe('denied');

    // The stored value is encrypted: the plaintext token is nowhere in the row.
    const { rows } = await handle.pool.query(
      `SELECT value, encrypted_value::text AS encrypted FROM system_settings WHERE key = 'metrics.credentials'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeNull();
    expect(rows[0].encrypted).toBeTruthy();
    expect(JSON.stringify(rows[0])).not.toContain(token);

    const replaced = await generateMetricsToken(ctx, null);
    invalidateSettings();
    expect(replaced).not.toBe(token);
    expect(await verifyMetricsToken(ctx, token)).toBe('denied');
    expect(await verifyMetricsToken(ctx, replaced)).toBe('ok');

    await clearMetricsToken(ctx);
    invalidateSettings();
    expect(await verifyMetricsToken(ctx, replaced)).toBe('disabled');
    expect(await isMetricsEnabled(ctx)).toBe(false);
  });
});
