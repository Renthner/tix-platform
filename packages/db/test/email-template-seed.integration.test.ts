/**
 * Seed behaviour for e-mail templates against a throw-away PostgreSQL database: defaults are
 * inserted once, rows that still equal a previous shipped default are upgraded, edited rows
 * and event overrides are never touched.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PREVIOUS_DEFAULT_FINGERPRINTS,
  createDb,
  defaultEmailTemplates,
  emailTemplateFingerprint,
  emailTemplates,
  upgradeUneditedEmailTemplates,
  type DbHandle,
} from '../src';
import { loadRootEnv } from '../src/env';
import { runMigrations } from '../src/migrate';
import { seedReferenceData } from '../src/seed';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('e-mail template seed', () => {
  const dbName = `tix_tpl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: pg.Client;
  let handle: DbHandle;

  const fetchRow = async (key: 'PAYMENT_RECEIVED_TICKETS' | 'TICKETS_RESENT', locale: string) => {
    const [row] = await handle.db
      .select()
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.key, key),
          eq(emailTemplates.locale, locale),
          isNull(emailTemplates.eventId),
        ),
      );
    return row!;
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 5, lockTimeoutMs: 20_000 });
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('shipped history never equals the current defaults', () => {
    const current = new Map(
      defaultEmailTemplates().map((t) => [`${t.key}|${t.locale}`, emailTemplateFingerprint(t)]),
    );
    for (const [slot, prints] of Object.entries(PREVIOUS_DEFAULT_FINGERPRINTS)) {
      expect(current.has(slot)).toBe(true);
      expect(prints).not.toContain(current.get(slot));
    }
  });

  it('upgrades only rows that still equal a previous default', async () => {
    const quiet = () => {};
    await seedReferenceData(handle.db, quiet);
    const defaults = defaultEmailTemplates();
    const current = defaults.find(
      (t) => t.key === 'PAYMENT_RECEIVED_TICKETS' && t.locale === 'en',
    )!;
    const currentDe = defaults.find(
      (t) => t.key === 'PAYMENT_RECEIVED_TICKETS' && t.locale === 'de',
    )!;

    // Simulate the old default (en) and an admin edit (de).
    const old = { subject: 'Old', bodyHtml: '<p>old {{orderNumber}}</p>', bodyText: 'old' };
    await handle.db
      .update(emailTemplates)
      .set({ ...old, isActive: false })
      .where(
        and(eq(emailTemplates.key, 'PAYMENT_RECEIVED_TICKETS'), eq(emailTemplates.locale, 'en')),
      );
    await handle.db
      .update(emailTemplates)
      .set({ subject: 'My own subject' })
      .where(
        and(eq(emailTemplates.key, 'PAYMENT_RECEIVED_TICKETS'), eq(emailTemplates.locale, 'de')),
      );

    const history = {
      'PAYMENT_RECEIVED_TICKETS|en': [emailTemplateFingerprint(old)],
      // the edited German row is not in the history by definition – list the original anyway
      'PAYMENT_RECEIVED_TICKETS|de': ['0'.repeat(64)],
    };
    expect(await upgradeUneditedEmailTemplates(handle.db, history)).toEqual([
      'PAYMENT_RECEIVED_TICKETS|en',
    ]);

    const en = await fetchRow('PAYMENT_RECEIVED_TICKETS', 'en');
    expect(en.bodyHtml).toBe(current.bodyHtml);
    expect(en.subject).toBe(current.subject);
    expect(en.isActive).toBe(false); // admin switch kept
    const de = await fetchRow('PAYMENT_RECEIVED_TICKETS', 'de');
    expect(de.subject).toBe('My own subject');
    expect(de.bodyHtml).toBe(currentDe.bodyHtml);

    // Idempotent: a second run (and a full seed) changes nothing.
    expect(await upgradeUneditedEmailTemplates(handle.db, history)).toEqual([]);
    await seedReferenceData(handle.db, quiet);
    expect((await fetchRow('PAYMENT_RECEIVED_TICKETS', 'de')).subject).toBe('My own subject');
  });

  it('leaves edited rows alone even if the edit is only in the body text', async () => {
    const [row] = await handle.db
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.key, 'TICKETS_RESENT'), eq(emailTemplates.locale, 'en')));
    const edited = { subject: row!.subject, bodyHtml: row!.bodyHtml, bodyText: 'edited text' };
    const baseline = { ...edited, bodyText: row!.bodyText };
    await handle.db
      .update(emailTemplates)
      .set({ bodyText: 'edited text' })
      .where(eq(emailTemplates.id, row!.id));
    const history = { 'TICKETS_RESENT|en': [emailTemplateFingerprint(baseline)] };
    expect(await upgradeUneditedEmailTemplates(handle.db, history)).toEqual([]);
    expect((await fetchRow('TICKETS_RESENT', 'en')).bodyText).toBe('edited text');
  });
});
