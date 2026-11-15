/**
 * The e-mail header setting reaches `shopVariables` (and with it the editor preview, the rendered
 * mails and the test mail) - against a real PostgreSQL (throwaway database).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, loadRootEnv, mediaAssets, type DbHandle } from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreContext, saveSetting, type CoreContext, type JobQueues } from '../src';
import { shopVariables } from '../src/email/variables';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!adminUrl || !redisUrl)('e-mail header setting (integration)', () => {
  const dbName = `tix_mailhdr_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let shopLogo: string;
  let overrideLogo: string;
  let webpLogo: string;

  async function asset(kind: 'LOGO' | 'EMAIL_IMAGE', mimeType: string, width: number) {
    const [row] = await handle.db
      .insert(mediaAssets)
      .values({
        kind,
        bucket: 'assets',
        objectKey: `k/${randomUUID()}`,
        fileName: 'logo',
        mimeType,
        sizeBytes: 10,
        sha256: randomBytes(16).toString('hex'),
        width,
        height: 40,
      })
      .returning({ id: mediaAssets.id });
    return row!.id;
  }

  const header = async () =>
    (await shopVariables(ctx, 'en')).variables.shopHeader as { html: string };

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
      appUrl: 'https://shop.example.org',
      secrets: createSecretBox(parseKeyRing(`t1:${randomBytes(32).toString('base64')}`)),
      jobs: { add: async () => 'job' } as unknown as JobQueues,
    });
    shopLogo = await asset('LOGO', 'image/png', 80);
    overrideLogo = await asset('EMAIL_IMAGE', 'image/png', 120);
    webpLogo = await asset('EMAIL_IMAGE', 'image/webp', 120);
    await saveSetting(ctx, 'branding', { logoAssetId: shopLogo }, null);
  });

  afterAll(async () => {
    await redis?.quit();
    await handle?.close?.();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('shows the logo directly (no box) without any stored header setting', async () => {
    const { html } = await header();
    expect(html).toContain(`/api/media/${shopLogo}`);
    expect(html).not.toMatch(/background|bgcolor/);
  });

  it('applies a saved chip configuration', async () => {
    await saveSetting(
      ctx,
      'emailHeader',
      { logoDisplay: 'CHIP', chipColor: '#eeeeee', chipCorners: 'SQUARE', logoHeight: 50 },
      null,
    );
    const { html } = await header();
    expect(html).toContain('background:#eeeeee;border-radius:0px');
    expect(html).toContain('height="50"');
  });

  it('prefers the dedicated e-mail logo and falls back when it is unusable', async () => {
    await saveSetting(ctx, 'emailHeader', { logoAssetId: overrideLogo }, null);
    expect((await header()).html).toContain(`/api/media/${overrideLogo}`);
    await saveSetting(ctx, 'emailHeader', { logoAssetId: webpLogo }, null);
    const { html } = await header();
    expect(html).toContain(`/api/media/${shopLogo}`);
    expect(html).not.toContain(webpLogo);
  });

  it('title only layout renders just the shop name', async () => {
    await saveSetting(ctx, 'emailHeader', { layout: 'TITLE_ONLY' }, null);
    expect((await header()).html).not.toContain('<img');
  });
});
