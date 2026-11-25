import { defaultAlertTypes, effectiveAlertTypes, selectableAlertTypes } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import {
  alertText,
  checkBackupFailed,
  checkBackupOverdue,
  checkBankSyncFailing,
  checkDiskLow,
  checkEmailDeliveryFailing,
  checkJobsFailing,
  checkPaymentProviderErrors,
  checkRefundsOpen,
  checkReviewCasesOpen,
  checkUpdateAvailable,
  isAlertDue,
  type BackupSnapshot,
} from '../src';

const now = new Date('2026-03-10T12:00:00Z');
const h = (n: number) => new Date(now.getTime() - n * 3_600_000);

const backup = (over: Partial<BackupSnapshot> = {}): BackupSnapshot => ({
  scheduleEnabled: true,
  frequency: 'DAILY',
  scheduledFailure: null,
  lastOperationFailure: null,
  newestBackupAt: h(2),
  externalFailure: null,
  scheduleConfiguredAt: h(1000),
  ...over,
});

describe('alert checks', () => {
  it('BACKUP_FAILED: failure after the newest backup, cleared by a newer success', () => {
    const failed = checkBackupFailed(backup({ scheduledFailure: { at: h(1), message: 'boom' } }));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ type: 'BACKUP_FAILED', key: 'BACKUP_FAILED' });
    expect(failed[0]!.details.reason).toBe('boom');
    expect(checkBackupFailed(backup({ scheduledFailure: { at: h(5), message: 'old' } }))).toEqual(
      [],
    );
    // A manual backup (newestBackupAt) does not close a scheduled failure / missed slot ...
    const scheduledOnly = backup({
      scheduledFailure: { at: h(5), message: 'Scheduled backup missed' },
      newestBackupAt: h(2),
      newestScheduledBackupAt: h(30),
    });
    expect(checkBackupFailed(scheduledOnly)).toHaveLength(1);
    // ... a newer scheduled one does.
    expect(checkBackupFailed({ ...scheduledOnly, newestScheduledBackupAt: h(3) })).toEqual([]);
    const external = checkBackupFailed(backup({ externalFailure: { at: h(2), message: 'x' } }));
    expect(external[0]!.variant).toBe('external');
  });

  it('BACKUP_OVERDUE: only with a schedule and after factor x interval', () => {
    const s = { backupOverdueFactor: 2 };
    expect(checkBackupOverdue(backup({ newestBackupAt: h(47) }), s, now)).toEqual([]);
    const late = checkBackupOverdue(backup({ newestBackupAt: h(49) }), s, now);
    expect(late).toHaveLength(1);
    expect(late[0]!.since).toEqual(new Date(h(49).getTime() + 48 * 3_600_000));
    expect(
      checkBackupOverdue(backup({ scheduleEnabled: false, newestBackupAt: h(500) }), s, now),
    ).toEqual([]);
    expect(
      checkBackupOverdue(backup({ frequency: 'WEEKLY', newestBackupAt: h(24 * 13) }), s, now),
    ).toEqual([]);
    expect(
      checkBackupOverdue(backup({ newestBackupAt: null, scheduleConfiguredAt: h(60) }), s, now)[0]!
        .variant,
    ).toBe('never');
  });

  it('BACKUP_OVERDUE: an old backup does not count before the freshly enabled schedule is due', () => {
    const s = { backupOverdueFactor: 2 };
    // Old manual backup (100 h ago), schedule enabled 1 h ago: not overdue yet.
    expect(
      checkBackupOverdue(backup({ newestBackupAt: h(100), scheduleConfiguredAt: h(1) }), s, now),
    ).toEqual([]);
    // 49 h after enabling without a newer backup: overdue, counted from the enabling.
    const late = checkBackupOverdue(
      backup({ newestBackupAt: h(100), scheduleConfiguredAt: h(49) }),
      s,
      now,
    );
    expect(late[0]!.since).toEqual(new Date(h(49).getTime() + 48 * 3_600_000));
  });

  it('DISK_LOW: file systems and the configured storage capacity', () => {
    const gb = 1024 ** 3;
    const s = { diskUsedPercent: 90, storageCapacityGb: 10 };
    expect(
      checkDiskLow(
        { filesystems: [{ path: '/', totalBytes: 100 * gb, freeBytes: 11 * gb }], storage: null },
        s,
      ),
    ).toEqual([]);
    const f = checkDiskLow(
      {
        filesystems: [{ path: '/', totalBytes: 100 * gb, freeBytes: 10 * gb }],
        storage: { databaseBytes: 5 * gb, bucketBytes: 4 * gb },
      },
      s,
    );
    expect(f.map((x) => x.key)).toEqual(['DISK_LOW:fs:/', 'DISK_LOW:storage']);
    expect(
      checkDiskLow(
        { filesystems: [], storage: { databaseBytes: 9 * gb, bucketBytes: 0 } },
        { ...s, storageCapacityGb: 0 },
      ),
    ).toEqual([]);
  });

  it('JOBS_FAILING: failures per hour and stale backlog per queue', () => {
    const s = { failedJobsPerHour: 10, queueBacklogMinutes: 30 };
    const q = (name: string, failedLastHour: number, oldestWaitingMs: number | null) => ({
      name,
      failedLastHour,
      oldestWaitingMs,
      lastFailure: 'err',
    });
    expect(checkJobsFailing({ queues: [q('a', 4, null), q('b', 5, 60_000)] }, s, now)).toEqual([]);
    const f = checkJobsFailing({ queues: [q('a', 4, null), q('b', 6, 31 * 60_000)] }, s, now);
    expect(f.map((x) => x.key)).toEqual(['JOBS_FAILING:failed', 'JOBS_FAILING:backlog:b']);
    expect(f[0]!.details.queue).toBe('b');
  });

  it('EMAIL_DELIVERY_FAILING, REVIEW_CASES_OPEN, REFUNDS_OPEN: threshold / count', () => {
    const limit = { failedEmailsPer24h: 3 };
    expect(
      checkEmailDeliveryFailing({ failedCount: 2, firstFailedAt: null, lastError: null }, limit),
    ).toEqual([]);
    expect(
      checkEmailDeliveryFailing({ failedCount: 3, firstFailedAt: h(3), lastError: 'x' }, limit),
    ).toHaveLength(1);
    expect(checkReviewCasesOpen({ count: 0, oldestAt: null })).toEqual([]);
    expect(checkReviewCasesOpen({ count: 2, oldestAt: h(100) })[0]!.details.count).toBe(2);
    expect(checkRefundsOpen({ count: 1, oldestAt: h(100) })).toHaveLength(1);
  });

  it('BANK_SYNC_FAILING: per connection, failed or TAN, after the grace period', () => {
    const c = (id: string, status: string, since: Date) => ({
      id,
      name: id,
      lastSyncStatus: status,
      lastError: null,
      healthySince: since,
    });
    const f = checkBankSyncFailing(
      [
        c('a', 'FAILED', h(7)),
        c('b', 'TAN_REQUIRED', h(7)),
        c('c', 'FAILED', h(2)),
        c('d', 'SUCCEEDED', h(99)),
      ],
      { bankSyncHours: 6 },
      now,
    );
    expect(f.map((x) => [x.key, x.variant])).toEqual([
      ['BANK_SYNC_FAILING:a', 'failed'],
      ['BANK_SYNC_FAILING:b', 'tan'],
    ]);
  });

  it('PAYMENT_PROVIDER_ERRORS: credential signal window and failed refunds', () => {
    const s = (paypal: Date | null, count: number) => ({
      paypalCredentials: paypal ? { at: paypal, environment: 'live' } : null,
      failedRefunds: { count, oldestAt: count ? h(5) : null, lastError: null },
    });
    expect(checkPaymentProviderErrors(s(h(30), 0), { paymentErrorHours: 24 }, now)).toEqual([]);
    expect(
      checkPaymentProviderErrors(s(h(1), 2), { paymentErrorHours: 24 }, now).map((x) => x.variant),
    ).toEqual(['credentials', 'refunds']);
  });

  it('UPDATE_AVAILABLE: one finding per version, none when pinned', () => {
    const base = { updateAvailable: true, pinned: false, current: '1.0.0', latest: '1.1.0' };
    expect(checkUpdateAvailable(base)[0]!.key).toBe('UPDATE_AVAILABLE:1.1.0');
    expect(checkUpdateAvailable({ ...base, pinned: true })).toEqual([]);
    expect(checkUpdateAvailable({ ...base, updateAvailable: false })).toEqual([]);
  });
});

describe('alert cooldown / digest', () => {
  const settings = { cooldownHours: 6, digestTime: '08:00' };
  it('normal alerts: first time, then after the cooldown', () => {
    const createdAt = h(10);
    const due = (lastSentAt: Date | null) =>
      isAlertDue('DISK_LOW', { lastSentAt, createdAt }, settings, 'UTC', now);
    expect(due(null)).toBe(true);
    expect(due(h(5))).toBe(false);
    expect(due(h(6))).toBe(true);
  });
  it('digests: once per daily slot, found-after-slot waits for the next one', () => {
    // The slot of today is 08:00Z (4 hours ago).
    const due = (lastSentAt: Date | null, createdAt: Date) =>
      isAlertDue('REFUNDS_OPEN', { lastSentAt, createdAt }, settings, 'UTC', now);
    expect(due(null, h(10))).toBe(true);
    expect(due(null, h(1))).toBe(false);
    expect(due(h(3), h(50))).toBe(false);
    expect(due(h(20), h(50))).toBe(true);
  });
  it('update notices are mailed once', () => {
    expect(
      isAlertDue(
        'UPDATE_AVAILABLE',
        { lastSentAt: h(500), createdAt: h(600) },
        settings,
        'UTC',
        now,
      ),
    ).toBe(false);
  });
});

describe('alert recipients and texts', () => {
  it('role defaults', () => {
    expect(defaultAlertTypes(['SUPER_ADMIN'])).not.toContain('UPDATE_AVAILABLE');
    expect(defaultAlertTypes(['SUPER_ADMIN'])).toHaveLength(10);
    expect([...defaultAlertTypes(['FINANCE'])].sort()).toEqual([
      'BANK_SYNC_FAILING',
      'PAID_CANCELLED_EVENT',
      'PAYMENT_PROVIDER_ERRORS',
      'REFUNDS_OPEN',
      'REVIEW_CASES_OPEN',
    ]);
    expect(defaultAlertTypes(['EVENT_MANAGER'])).toEqual([]);
    expect(selectableAlertTypes(['EVENT_MANAGER'])).toEqual([]);
  });
  it('preferences are limited to what the roles allow', () => {
    expect(effectiveAlertTypes(['FINANCE'], { types: ['DISK_LOW', 'REFUNDS_OPEN'] })).toEqual([
      'REFUNDS_OPEN',
    ]);
    expect(effectiveAlertTypes(['SUPER_ADMIN'], { types: ['UPDATE_AVAILABLE'] })).toEqual([
      'UPDATE_AVAILABLE',
    ]);
    expect(effectiveAlertTypes(['FINANCE'], null)).toEqual(defaultAlertTypes(['FINANCE']));
    expect(effectiveAlertTypes(['SUPER_ADMIN'], { types: [] })).toEqual([]);
  });
  it('texts exist in both languages', () => {
    for (const locale of ['en', 'de']) {
      const t = alertText(
        'BANK_SYNC_FAILING',
        { variant: 'tan', connection: 'Main' },
        locale,
        'UTC',
      );
      expect(t.title).toContain('Main');
      expect(t.title).not.toMatch(/^alerts\./);
      const b = alertText('BACKUP_FAILED', { variant: 'failed', reason: null }, locale, 'UTC');
      expect(b.summary).not.toMatch(/\{/);
    }
  });
});
