/**
 * Audit round: unique access-code redemptions (migration 0042 dedupe + ON CONFLICT redemption)
 * and order access-token versioning / admin reset. Throw-away database.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  accessCodeRedemptions,
  accessCodes,
  createDb,
  loadRootEnv,
  orderHistory,
  orders,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  DomainError,
  issueOrderAccessToken,
  orderAccessToken,
  redeemAccessCode,
  revokeOrderAccessTokens,
  verifyOrderAccessToken,
  type CoreContext,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const enabled = process.env.TIX_TEST_THROWAWAY === '1' && adminUrl && redisUrl;

describe.skipIf(!enabled)('access codes + order access tokens (integration)', () => {
  const dbName = `tix_ah_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let dbUrl: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    await runMigrations({
      connectionString: dbUrl,
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: dbUrl, poolMax: 5 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'https://shop.example',
      secrets: createSecretBox(parseKeyRing(`k1:${Buffer.alloc(32, 7).toString('base64')}`)),
    });
  });

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  async function newCode(max: number | null = null) {
    const [code] = await handle.db
      .insert(accessCodes)
      .values({
        code: `AH${randomUUID().slice(0, 8).toUpperCase()}`,
        type: 'MULTI_USE',
        maxRedemptions: max,
      })
      .returning();
    return code!;
  }
  // Global code (event_id NULL): redeemAccessCode only needs the event id.
  const event = () => ({ id: randomUUID() }) as never;

  async function newOrder() {
    const [order] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `AH-${randomUUID().slice(0, 8)}`,
        status: 'PENDING',
        channel: 'BOX_OFFICE',
        paymentMethod: 'CASH',
        firstName: '',
        lastName: '',
        locale: 'en',
        currency: 'EUR',
        subtotalGross: 0,
        feeTotal: 0,
        totalGross: 0,
        totalNet: 0,
        totalTax: 0,
      })
      .returning();
    return order!;
  }

  describe('access code redemption', () => {
    it('counts a session once, also under concurrency', async () => {
      const code = await newCode(5);
      const ev = event();
      await Promise.all(
        Array.from({ length: 8 }, () => redeemAccessCode(ctx, ev, 'sess-a', code.code)),
      );
      const [row] = await handle.db.select().from(accessCodes).where(eq(accessCodes.id, code.id));
      expect(row!.redemptionCount).toBe(1);
      const rows = await handle.db
        .select()
        .from(accessCodeRedemptions)
        .where(eq(accessCodeRedemptions.accessCodeId, code.id));
      expect(rows).toHaveLength(1);
    });

    it('still enforces maxRedemptions across sessions and rolls the insert back', async () => {
      const code = await newCode(1);
      const ev = event();
      await redeemAccessCode(ctx, ev, 'sess-1', code.code);
      await expect(redeemAccessCode(ctx, ev, 'sess-2', code.code)).rejects.toMatchObject({
        code: 'CODE_EXHAUSTED',
      });
      const rows = await handle.db
        .select()
        .from(accessCodeRedemptions)
        .where(eq(accessCodeRedemptions.accessCodeId, code.id));
      expect(rows).toHaveLength(1);
    });

    it('unique index rejects a duplicate (code, session)', async () => {
      const code = await newCode();
      await handle.db
        .insert(accessCodeRedemptions)
        .values({ accessCodeId: code.id, sessionId: 's' });
      await expect(
        handle.db.insert(accessCodeRedemptions).values({ accessCodeId: code.id, sessionId: 's' }),
      ).rejects.toThrow();
    });

    it('migration 0042 dedupe keeps the earliest row and corrects the counter', async () => {
      const code = await newCode();
      const client = new pg.Client({ connectionString: dbUrl });
      await client.connect();
      try {
        await client.query('DROP INDEX "access_code_redemptions_code_session_uq"');
        const ins = (at: string) =>
          client.query(
            `INSERT INTO access_code_redemptions (access_code_id, session_id, redeemed_at) VALUES ($1, 'dup', $2) RETURNING id`,
            [code.id, at],
          );
        const first = await ins('2026-01-01T10:00:00Z');
        await ins('2026-01-01T10:00:01Z');
        await ins('2026-01-01T10:00:02Z');
        await client.query(
          `INSERT INTO access_code_redemptions (access_code_id, session_id) VALUES ($1, 'other')`,
          [code.id],
        );
        await client.query('UPDATE access_codes SET redemption_count = 4 WHERE id = $1', [code.id]);

        const statements = readFileSync(
          resolve(
            import.meta.dirname,
            '../../db/migrations/0042_access_redemption_unique_token_version.sql',
          ),
          'utf8',
        ).split('--> statement-breakpoint');
        // The real migrator runs every migration inside a transaction (LOCK TABLE needs one).
        await client.query('BEGIN');
        await client.query(statements[0]!); // lock + dedupe + counter correction
        await client.query(statements[1]!); // dedupe + counter correction
        await client.query(statements[2]!); // unique index again
        await client.query('COMMIT');

        const rows = await client.query(
          `SELECT id, session_id FROM access_code_redemptions WHERE access_code_id = $1 ORDER BY session_id`,
          [code.id],
        );
        expect(rows.rows.map((r) => r.session_id)).toEqual(['dup', 'other']);
        expect(rows.rows[0].id).toBe(first.rows[0].id);
        const counter = await client.query(
          'SELECT redemption_count FROM access_codes WHERE id = $1',
          [code.id],
        );
        expect(counter.rows[0].redemption_count).toBe(2);
      } finally {
        await client.end();
      }
    });
  });

  describe('order access token version', () => {
    it('verifies version-0 tokens and rejects tokens of unknown orders', async () => {
      const order = await newOrder();
      expect(await verifyOrderAccessToken(ctx, orderAccessToken(ctx, order.id))).toBe(order.id);
      expect(await verifyOrderAccessToken(ctx, await issueOrderAccessToken(ctx, order.id))).toBe(
        order.id,
      );
      expect(await verifyOrderAccessToken(ctx, orderAccessToken(ctx, randomUUID()))).toBeNull();
    });

    it('revoke invalidates old links, new ones work, history entries are written', async () => {
      const order = await newOrder();
      const oldToken = orderAccessToken(ctx, order.id);
      const { tokenVersion } = await revokeOrderAccessTokens(ctx, order.id, { userId: null });
      expect(tokenVersion).toBe(1);
      expect(await verifyOrderAccessToken(ctx, oldToken)).toBeNull();
      const fresh = await issueOrderAccessToken(ctx, order.id);
      expect(fresh).not.toBe(oldToken);
      expect(await verifyOrderAccessToken(ctx, fresh)).toBe(order.id);
      await revokeOrderAccessTokens(ctx, order.id, { userId: null });
      expect(await verifyOrderAccessToken(ctx, fresh)).toBeNull();
      const history = await handle.db
        .select()
        .from(orderHistory)
        .where(eq(orderHistory.orderId, order.id));
      expect(history.filter((h) => h.type === 'access_tokens_revoked')).toHaveLength(2);
    });

    it('revoke of an unknown order is ORDER_NOT_FOUND', async () => {
      await expect(
        revokeOrderAccessTokens(ctx, randomUUID(), { userId: null }),
      ).rejects.toBeInstanceOf(DomainError);
    });
  });
});
