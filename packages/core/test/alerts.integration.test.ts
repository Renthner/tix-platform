/**
 * Admin warning e-mails against real PostgreSQL + Redis (throwaway database): a failed backup
 * queues one alert mail per recipient (no repeat inside the cooldown), clearing it queues one
 * "resolved" mail, the hourly cap holds mails back, preferences decide the recipients.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminAlerts,
  adminUsers,
  createDb,
  emailMessages,
  loadRootEnv,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, hashPassword, parseKeyRing } from '@tix/shared/server';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearBackupFailure,
  createCoreContext,
  getBackupFailure,
  getOwnAlertPreferences,
  listAlertHistory,
  recordBackupFailure,
  runAlertCycle,
  runBackupJob,
  runBackupTick,
  saveOwnAlertPreferences,
  saveSetting,
  sendBackupAlert,
  type BackupRuntime,
  type CoreContext,
  type JobQueues,
} from '../src';

// Backups and SMTP are stubbed per test; everything else is the real code.
vi.mock('../src/backup/create', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/backup/create')>()),
  createBackup: vi.fn(async () => ({})),
}));
vi.mock('../src/email/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/email/transport')>();
  return { ...actual, smtpSender: vi.fn(actual.smtpSender) };
});

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!adminUrl || !redisUrl)('admin alerts (integration)', () => {
  const dbName = `tix_alerts_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let rt: BackupRuntime;
  let superId: string;
  let financeId: string;
  // The machine running the tests may be nearly full: no real directory is checked.
  const NO_DISK = { diskPaths: '/tix-test-does-not-exist' };
  const ALERT_KEYS = ['ADMIN_ALERT', 'ADMIN_ALERT_RESOLVED'] as const;

  const alertMails = () =>
    handle.db
      .select({ key: emailMessages.templateKey, to: emailMessages.toEmail })
      .from(emailMessages)
      .where(inArray(emailMessages.templateKey, [...ALERT_KEYS]));

  async function makeUser(email: string, roles: ('SUPER_ADMIN' | 'FINANCE' | 'EVENT_MANAGER')[]) {
    const [row] = await handle.db
      .insert(adminUsers)
      .values({
        email,
        displayName: email.split('@')[0]!,
        roles,
        passwordHash: await hashPassword('correct horse battery'),
      })
      .returning({ id: adminUsers.id });
    return row!.id;
  }

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
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    const jobs = {
      add: async (_q: string, _n: string, data: { messageId: string }) => `job-${data.messageId}`,
    } as unknown as JobQueues;
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'https://shop.example.org',
      secrets: createSecretBox(parseKeyRing(`t1:${randomBytes(32).toString('base64')}`)),
      jobs,
    });
    // Backup runtime with an empty catalogue (no S3 needed).
    rt = {
      ctx,
      buckets: { backups: { listDirectories: async () => [] } },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as unknown as BackupRuntime;
    superId = await makeUser('boss@example.org', ['SUPER_ADMIN']);
    financeId = await makeUser('money@example.org', ['FINANCE']);
    await makeUser('events@example.org', ['EVENT_MANAGER']);
    await saveSetting(ctx, 'backup', { scheduleEnabled: false }, null);
    await saveSetting(ctx, 'alerts', NO_DISK, null);
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) {
      const keys = await redis.keys(`${ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('does nothing without a problem', async () => {
    const r = await runAlertCycle(ctx, { backups: rt });
    expect(r.opened).toBe(0);
    expect(await alertMails()).toHaveLength(0);
  });

  it('a failed backup queues one mail for the super admin only, once per cooldown', async () => {
    const t0 = new Date('2026-03-10T10:00:00Z');
    await recordBackupFailure(ctx, { at: t0.toISOString(), message: 'bucket unreachable' });
    const first = await runAlertCycle(ctx, { backups: rt }, t0);
    expect(first).toMatchObject({ opened: 1, sent: 1 });
    // FINANCE and EVENT_MANAGER do not get backup alerts by default.
    expect(await alertMails()).toEqual([{ key: 'ADMIN_ALERT', to: 'boss@example.org' }]);

    // Evaluated again 1 hour later: same alert, inside the 6 h cooldown, no new mail.
    const again = await runAlertCycle(ctx, { backups: rt }, new Date(t0.getTime() + 3_600_000));
    expect(again).toMatchObject({ opened: 0, sent: 0 });
    expect(await alertMails()).toHaveLength(1);

    // After the cooldown it is repeated.
    const later = await runAlertCycle(ctx, { backups: rt }, new Date(t0.getTime() + 7 * 3_600_000));
    expect(later.sent).toBe(1);
    expect(await alertMails()).toHaveLength(2);
    const [row] = await handle.db
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.type, 'BACKUP_FAILED'));
    expect(row).toMatchObject({ sendCount: 2, resolvedAt: null });
  });

  it('clearing the problem closes the alert and queues one resolved mail', async () => {
    await clearBackupFailure(ctx);
    const t = new Date('2026-03-10T20:00:00Z');
    const r = await runAlertCycle(ctx, { backups: rt }, t);
    expect(r).toMatchObject({ resolved: 1, resolvedMailed: 1 });
    const mails = await alertMails();
    expect(mails.filter((m) => m.key === 'ADMIN_ALERT_RESOLVED')).toHaveLength(1);
    // No second resolved mail.
    await runAlertCycle(ctx, { backups: rt }, new Date(t.getTime() + 300_000));
    expect((await alertMails()).filter((m) => m.key === 'ADMIN_ALERT_RESOLVED')).toHaveLength(1);
    const history = await listAlertHistory(ctx);
    expect(history[0]).toMatchObject({ type: 'BACKUP_FAILED' });
    expect(history[0]!.resolvedAt).not.toBeNull();
  });

  it('preferences decide the recipients and are limited to the role', async () => {
    const prefs = await getOwnAlertPreferences(ctx, financeId);
    expect(prefs.isDefault).toBe(true);
    expect(prefs.selectable).not.toContain('BACKUP_FAILED');
    await expect(
      saveOwnAlertPreferences(ctx, { userId: financeId }, ['BACKUP_FAILED']),
    ).rejects.toMatchObject({ code: 'ALERT_TYPE_NOT_ALLOWED' });
    await saveOwnAlertPreferences(ctx, { userId: superId }, ['DISK_LOW']);
    const before = (await alertMails()).length;
    await recordBackupFailure(ctx, { at: '2026-03-11T10:00:00.000Z', message: 'again' });
    await runAlertCycle(ctx, { backups: rt }, new Date('2026-03-11T10:05:00Z'));
    // The super admin opted out of BACKUP_FAILED: the alert is recorded but nobody is mailed.
    expect((await alertMails()).length).toBe(before);
    await clearBackupFailure(ctx);
  });

  it('the hourly cap holds alerts back and the switch disables everything', async () => {
    await saveSetting(ctx, 'alerts', { ...NO_DISK, maxMailsPerHour: 1 }, null);
    await saveOwnAlertPreferences(ctx, { userId: superId }, ['BACKUP_FAILED', 'BACKUP_OVERDUE']);
    await saveSetting(ctx, 'backup', { scheduleEnabled: true, frequency: 'DAILY' }, null);
    const t = new Date();
    await recordBackupFailure(ctx, { at: t.toISOString(), message: 'cap' });
    const r = await runAlertCycle(ctx, { backups: rt }, t);
    // Earlier mails of the last hour already used the cap of 1: everything is held back.
    expect(r.sent).toBe(0);
    expect(r.deferred).toBeGreaterThanOrEqual(1);
    await saveSetting(ctx, 'alerts', { ...NO_DISK, enabled: false }, null);
    expect((await runAlertCycle(ctx, { backups: rt }, t)).skipped).toBe('DISABLED');
  });

  it('a schedule enabled after the daily slot raises no "missed" failure, sends no mail', async () => {
    await saveSetting(ctx, 'general', { defaultTimeZone: 'UTC' }, null);
    const now = new Date();
    const slotHour = (now.getUTCHours() + 24 - 7) % 24;
    const time = `${String(slotHour).padStart(2, '0')}:00`;
    await saveSetting(ctx, 'backup', { scheduleEnabled: true, frequency: 'DAILY', time }, null);
    await clearBackupFailure(ctx);
    // The newest slot lies 7-8 h back = before the schedule was saved, beyond the catch-up window.
    expect(await runBackupTick(rt, now)).toBe('idle');
    expect(await getBackupFailure(ctx)).toBeNull();
    // A later slot that really passed without a run is still reported.
    expect(await runBackupTick(rt, new Date(now.getTime() + 24 * 3_600_000))).toBe('idle');
    expect(await getBackupFailure(ctx)).toMatchObject({
      message: expect.stringContaining('Scheduled backup missed'),
    });
    await clearBackupFailure(ctx);
    await saveSetting(ctx, 'backup', { scheduleEnabled: false }, null);
  });

  it('the schedule reference moves only with the schedule, not with any save of the backup tab', async () => {
    await saveSetting(ctx, 'general', { defaultTimeZone: 'UTC' }, null);
    const now = new Date();
    const slotHour = (now.getUTCHours() + 24 - 7) % 24;
    const time = `${String(slotHour).padStart(2, '0')}:00`;
    // Configured 3 days ago; the slot 7-8 h back lies AFTER that, but the row was saved just now
    // (an unrelated change such as the retention). Fallback to updated_at would hide the miss.
    await saveSetting(
      ctx,
      'backup',
      {
        scheduleEnabled: true,
        frequency: 'DAILY',
        time,
        scheduleConfiguredAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
        keepScheduled: 20,
      },
      null,
    );
    await clearBackupFailure(ctx);
    expect(await runBackupTick(rt, now)).toBe('idle');
    expect(await getBackupFailure(ctx)).toMatchObject({
      message: expect.stringContaining('Scheduled backup missed'),
    });
    await clearBackupFailure(ctx);
    await saveSetting(ctx, 'backup', { scheduleEnabled: false }, null);
  });

  it('a manual backup after a missed slot neither clears it nor causes a second mail', async () => {
    const opsMails = async () => (await alertMails()).filter((m) => m.to === 'ops@example.org');
    await saveSetting(ctx, 'general', { defaultTimeZone: 'UTC' }, null);
    const now = new Date();
    const slotHour = (now.getUTCHours() + 24 - 7) % 24;
    const time = `${String(slotHour).padStart(2, '0')}:00`;
    await saveSetting(
      ctx,
      'backup',
      {
        scheduleEnabled: true,
        frequency: 'DAILY',
        time,
        alertEmail: 'ops@example.org',
        scheduleConfiguredAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      },
      null,
    );
    await clearBackupFailure(ctx);
    const before = (await opsMails()).length;
    expect(await runBackupTick(rt, now)).toBe('idle');
    expect((await opsMails()).length).toBe(before + 1);
    const missed = await getBackupFailure(ctx);
    expect(missed?.message).toContain('Scheduled backup missed');

    // A manual backup completes: the missed marker stays (portal flag and alert agree) ...
    await runBackupJob(rt, { kind: 'MANUAL', userId: null });
    expect(await getBackupFailure(ctx)).toEqual(missed);
    // ... and the next tick does not record / mail the same miss again.
    expect(await runBackupTick(rt, new Date(now.getTime() + 60_000))).toBe('idle');
    expect((await opsMails()).length).toBe(before + 1);

    // A real failure of a manual backup is closed by the next manual success ...
    await recordBackupFailure(ctx, { at: now.toISOString(), message: 'disk full' });
    await runBackupJob(rt, { kind: 'MANUAL', userId: null });
    expect(await getBackupFailure(ctx)).toBeNull();
    // ... and a scheduled backup closes the missed marker.
    await recordBackupFailure(ctx, missed!);
    await runBackupJob(rt, { kind: 'SCHEDULED', userId: null });
    expect(await getBackupFailure(ctx)).toBeNull();
    await saveSetting(ctx, 'backup', { scheduleEnabled: false }, null);
  });

  it('falls back to a direct SMTP mail when the outbox (database / queue) fails', async () => {
    const { smtpSender } = await import('../src/email/transport');
    const sendMail = vi.fn(async () => ({}));
    vi.mocked(smtpSender).mockResolvedValueOnce({
      from: 'shop@example.org',
      transporter: { sendMail },
    } as never);
    const brokenDb = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === 'insert' || prop === 'transaction') {
          return () => {
            throw new Error('database down');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const before = (await alertMails()).length;
    await expect(
      sendBackupAlert({ ...ctx, db: brokenDb } as CoreContext, 'ops@example.org', 'dump failed'),
    ).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@example.org',
        text: expect.stringContaining('Reason: dump failed'),
      }),
    );
    expect((await alertMails()).length).toBe(before);
  });

  it('the legacy backup failure mail uses the HTML alert template', async () => {
    const before = (await alertMails()).length;
    await sendBackupAlert(ctx, 'ops@example.org', 'disk full');
    const mails = await alertMails();
    expect(mails.length).toBe(before + 1);
    expect(mails.some((m) => m.key === 'ADMIN_ALERT' && m.to === 'ops@example.org')).toBe(true);
  });
});
