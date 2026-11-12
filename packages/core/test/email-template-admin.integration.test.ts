/**
 * E-mail template admin service against a throw-away PostgreSQL database: listing, saving
 * (sanitising + validation), event overrides, reset to default, test send and the preview.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  emailMessages,
  emailTemplates,
  events,
  loadRootEnv,
  seatMaps,
  taxRates,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { EMAIL_TEMPLATE_KEYS } from '@tix/shared';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EmailTemplateInvalidError,
  createCoreContext,
  createEmailTemplateOverride,
  defaultEmailTemplate,
  deleteEmailTemplateOverride,
  getEditableEmailTemplate,
  listEmailTemplates,
  previewEmailTemplate,
  resetEmailTemplate,
  saveEmailTemplate,
  sendDraftTestEmail,
  type CoreContext,
  type MailSender,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();

describe.skipIf(!adminUrl || !redisUrl)('e-mail template admin (integration)', () => {
  const dbName = `tix_tpladmin_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let eventId: string;

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
    handle = createDb({ connectionString: url.toString(), poolMax: 5 });
    await seedReferenceData(handle.db, () => {});
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${uuid().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'https://shop.example.org',
      secrets: createSecretBox(parseKeyRing(`t1:${randomBytes(32).toString('base64')}`)),
    });
    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Hall',
        canvasWidth: 100,
        canvasHeight: 100,
      })
      .returning();
    const [tax] = await handle.db
      .insert(taxRates)
      .values({ name: `t-${uuid()}`, rateBasisPoints: 700 })
      .returning();
    const [event] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `gala-${uuid().slice(0, 6)}`,
        title: 'Gala',
        startsAt: new Date(Date.now() + 20 * 86_400_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
      })
      .returning();
    eventId = event!.id;
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) await redis.quit();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  const key = 'ORDER_CANCELLED' as const;

  it('lists every key with default status and no overrides', async () => {
    const list = await listEmailTemplates(handle.db);
    expect(list).toHaveLength(EMAIL_TEMPLATE_KEYS.length);
    const entry = list.find((e) => e.key === key)!;
    expect(entry.locales.en).toMatchObject({ exists: true, isActive: true, isDefault: true });
    expect(entry.locales.de.isDefault).toBe(true);
    expect(entry.overrides).toEqual([]);
  });

  it('saves a sanitised template and marks it as customised', async () => {
    const result = await saveEmailTemplate(ctx, handle.db, {
      key,
      locale: 'en',
      eventId: null,
      subject: 'Cancelled {{orderNumber}} {{bogus}}',
      bodyHtml: '<p onclick="x()">Hi {{firstName}}</p><script>alert(1)</script>',
      bodyText: '',
      isActive: true,
      userId: null,
    });
    expect(result.row.bodyHtml).toBe('<p>Hi {{firstName}}</p>');
    expect(result.row.bodyText).toBeNull();
    expect(result.warnings).toEqual([
      { field: 'subject', code: 'unknownPlaceholder', detail: 'bogus' },
    ]);
    const edited = await getEditableEmailTemplate(handle.db, key, 'en', null);
    expect(edited.isDefault).toBe(false);
    expect(edited.draft.subject).toBe('Cancelled {{orderNumber}} {{bogus}}');
  });

  it('rejects unbalanced sections without touching the stored text', async () => {
    await expect(
      saveEmailTemplate(ctx, handle.db, {
        key,
        locale: 'en',
        eventId: null,
        subject: 'S',
        bodyHtml: '<p>{{#if iban}}x</p>',
        bodyText: null,
        isActive: true,
        userId: null,
      }),
    ).rejects.toBeInstanceOf(EmailTemplateInvalidError);
    const [row] = await handle.db
      .select()
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.key, key),
          eq(emailTemplates.locale, 'en'),
          isNull(emailTemplates.eventId),
        ),
      );
    expect(row!.bodyHtml).toBe('<p>Hi {{firstName}}</p>');
  });

  it('resets to the shipped default', async () => {
    const row = await resetEmailTemplate(handle.db, {
      key,
      locale: 'en',
      eventId: null,
      userId: null,
    });
    expect(row.subject).toBe(defaultEmailTemplate(key, 'en').subject);
    expect((await getEditableEmailTemplate(handle.db, key, 'en', null)).isDefault).toBe(true);
  });

  it('creates, edits and deletes an event override', async () => {
    const created = await createEmailTemplateOverride(handle.db, {
      key,
      locale: 'de',
      eventId,
      userId: null,
    });
    expect(created.eventId).toBe(eventId);
    expect(created.subject).toBe(defaultEmailTemplate(key, 'de').subject);
    // idempotent
    expect(
      (await createEmailTemplateOverride(handle.db, { key, locale: 'de', eventId, userId: null }))
        .id,
    ).toBe(created.id);

    await saveEmailTemplate(ctx, handle.db, {
      key,
      locale: 'de',
      eventId,
      subject: 'Gala abgesagt',
      bodyHtml: '<p>Leider.</p>',
      bodyText: 'Leider.',
      isActive: true,
      userId: null,
    });
    const list = await listEmailTemplates(handle.db);
    expect(list.find((e) => e.key === key)!.overrides).toEqual([
      { eventId, eventTitle: 'Gala', locale: 'de', isActive: true },
    ]);
    // The global German template stays untouched.
    expect((await getEditableEmailTemplate(handle.db, key, 'de', null)).isDefault).toBe(true);

    await deleteEmailTemplateOverride(handle.db, { key, locale: 'de', eventId });
    await expect(
      deleteEmailTemplateOverride(handle.db, { key, locale: 'de', eventId }),
    ).rejects.toMatchObject({ code: 'EMAIL_TEMPLATE_NOT_FOUND' });
  });

  it('previews an unsaved draft with sample data and reports errors without rendering', async () => {
    const ok = await previewEmailTemplate(ctx, key, 'en', {
      subject: 'Cancelled {{orderNumber}}',
      bodyHtml: '<p>{{firstName}} – {{amount}}</p>{{itemsTable}}',
      bodyText: null,
    });
    expect(ok.subject).toBe('Cancelled 2026-000123');
    expect(ok.html).toContain('<p>Alex – 48,00 €</p>');
    expect(ok.html).toContain('<table');
    expect(ok.text).toContain('Alex');
    const bad = await previewEmailTemplate(ctx, key, 'en', {
      subject: 'x',
      bodyHtml: '{{#if a}}',
      bodyText: null,
    });
    expect(bad.html).toBe('');
    expect(bad.validation.errors).toHaveLength(1);
  });

  it('sends the draft as test e-mail through the given transport and logs it', async () => {
    const sent: Record<string, unknown>[] = [];
    const sender = {
      from: { name: 'Shop', address: 'shop@example.org' },
      transporter: {
        sendMail: async (mail: Record<string, unknown>) => {
          sent.push(mail);
          return { messageId: '<test@example.org>' };
        },
      },
    } as unknown as MailSender;
    const result = await sendDraftTestEmail(ctx, {
      key,
      locale: 'de',
      to: 'admin@example.org',
      draft: { subject: 'Hallo {{firstName}}', bodyHtml: '<p>{{orderNumber}}</p>', bodyText: null },
      sender,
    });
    expect(result.ok).toBe(true);
    expect(sent[0]).toMatchObject({
      to: 'admin@example.org',
      subject: '[Test] Hallo Alex',
      html: '<p>2026-000123</p>',
    });
    const [log] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.toEmail, 'admin@example.org'));
    expect(log).toMatchObject({
      status: 'SENT',
      templateKey: key,
      providerMessageId: '<test@example.org>',
    });

    const failing = {
      ...sender,
      transporter: {
        sendMail: async () => {
          throw new Error('connection refused');
        },
      },
    } as unknown as MailSender;
    const failed = await sendDraftTestEmail(ctx, {
      key,
      locale: 'en',
      to: 'admin@example.org',
      draft: { subject: 'S', bodyHtml: '<p>x</p>', bodyText: null },
      sender: failing,
    });
    expect(failed).toEqual({
      ok: false,
      error: 'connection refused',
      reason: 'delivery',
      kind: 'other',
    });
  });
});
