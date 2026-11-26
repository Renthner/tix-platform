import { adminAlerts, adminUsers, emailMessages, withTransaction } from '@tix/db';
import {
  effectiveAlertTypes,
  isDigestAlert,
  isResolvedMailAlert,
  ONCE_ALERT_TYPES,
  type AdminAlertType,
} from '@tix/shared';
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email/request';
import { formatDateTime } from '../format';
import { coreLog } from '../log';
import { getSetting } from '../settings';
import { latestScheduledSlot } from '../backup/schedule';
import { type AlertDetails, type AlertFinding, type AlertSettings } from './checks';
import { ALERT_TEMPLATE_KEYS, collectFindings, type CollectDeps } from './collect';
import { alertText } from './text';

export { alertText, type AlertText } from './text';

const HOUR_MS = 3_600_000;
/** A "resolved" mail that could not go out (rate limit) is retried for this long. */
const RESOLVED_RETRY_MS = 24 * HOUR_MS;

export interface AlertRecipient {
  userId: string;
  email: string;
  displayName: string;
  types: ReadonlySet<AdminAlertType>;
}

/** Active admins who accepted their invitation, with the alert types their roles + preferences allow. */
export async function loadAlertRecipients(ctx: CoreContext): Promise<AlertRecipient[]> {
  const rows = await ctx.db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      displayName: adminUsers.displayName,
      roles: adminUsers.roles,
      alertPreferences: adminUsers.alertPreferences,
    })
    .from(adminUsers)
    .where(and(eq(adminUsers.isActive, true), isNotNull(adminUsers.passwordHash)));
  return rows
    .map((r) => ({
      userId: r.id,
      email: r.email,
      displayName: r.displayName,
      types: new Set(effectiveAlertTypes(r.roles, r.alertPreferences)),
    }))
    .filter((r) => r.types.size > 0);
}

export interface DueInput {
  lastSentAt: Date | null;
  /** Creation of the alert row (= first evaluation that found the problem). */
  createdAt: Date;
}

/**
 * Whether an open alert must be mailed now. Normal alerts: the first time, then again after the
 * cooldown. Digest alerts: once per daily slot (a problem found after today's slot waits for
 * tomorrow's). Once-alerts (update notices): only the first time.
 */
export function isAlertDue(
  type: AdminAlertType,
  row: DueInput,
  settings: Pick<AlertSettings, 'cooldownHours' | 'digestTime'>,
  timeZone: string,
  now: Date,
): boolean {
  if (isDigestAlert(type)) {
    const slot = latestScheduledSlot(
      { frequency: 'DAILY', weekday: 0, time: settings.digestTime },
      timeZone,
      now,
    );
    return (row.lastSentAt ?? row.createdAt).getTime() < slot.getTime();
  }
  if (row.lastSentAt === null) return true;
  if (ONCE_ALERT_TYPES.includes(type)) return false;
  return now.getTime() - row.lastSentAt.getTime() >= settings.cooldownHours * HOUR_MS;
}

const ADMIN_PAGE: Record<AdminAlertType, string> = {
  BACKUP_FAILED: 'backups',
  BACKUP_OVERDUE: 'backups',
  DISK_LOW: 'system',
  JOBS_FAILING: 'system',
  EMAIL_DELIVERY_FAILING: 'system',
  UPDATE_AVAILABLE: 'system',
  REVIEW_CASES_OPEN: 'banking/review',
  BANK_SYNC_FAILING: 'banking/connections',
  PAYMENT_PROVIDER_ERRORS: 'refunds',
  REFUNDS_OPEN: 'refunds',
  PAID_CANCELLED_EVENT: 'orders',
};

function adminLink(ctx: CoreContext, locale: string, type: AdminAlertType, variant: string) {
  if (!ctx.appUrl) return '';
  const page =
    type === 'PAYMENT_PROVIDER_ERRORS' && variant === 'credentials'
      ? 'settings/payments'
      : ADMIN_PAGE[type];
  return `${ctx.appUrl.replace(/\/+$/, '')}/${locale}/admin/${page}`;
}

async function mailsInLastHour(ctx: CoreContext, now: Date): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(
      and(
        inArray(emailMessages.templateKey, [...ALERT_TEMPLATE_KEYS]),
        gte(emailMessages.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    );
  return row?.n ?? 0;
}

export interface AlertCycleResult {
  skipped: 'DISABLED' | null;
  opened: number;
  sent: number;
  resolved: number;
  resolvedMailed: number;
  /** Alerts that were due but held back (rate limit, nobody to tell). */
  deferred: number;
}

/**
 * One evaluation of all alert checks (run every few minutes by a worker job):
 *  1. collects findings and reconciles them with the open alerts (`admin_alerts`),
 *  2. mails new / due alerts to every admin whose roles and preferences include the type
 *     (outbox rows in one transaction with the alert row, dispatched after the commit),
 *  3. closes alerts whose condition cleared and mails a short "resolved" note when the alert
 *     had been mailed.
 * The hourly cap counts alert mails of all recipients together; held-back alerts stay unsent
 * (`last_sent_at` NULL / old) and go out in a later cycle.
 */
export async function runAlertCycle(
  ctx: CoreContext,
  deps: CollectDeps = {},
  now: Date = new Date(),
): Promise<AlertCycleResult> {
  const result: AlertCycleResult = {
    skipped: null,
    opened: 0,
    sent: 0,
    resolved: 0,
    resolvedMailed: 0,
    deferred: 0,
  };
  const [settings, general] = await Promise.all([
    getSetting(ctx, 'alerts'),
    getSetting(ctx, 'general'),
  ]);
  if (!settings.enabled) return { ...result, skipped: 'DISABLED' };
  const locale = general.defaultLocale;
  const timeZone = general.defaultTimeZone;

  const recipients = await loadAlertRecipients(ctx);
  const wanted = new Set(recipients.flatMap((r) => [...r.types]));
  const { findings, evaluated } = await collectFindings(
    ctx,
    { ...deps, wanted: deps.wanted ?? wanted },
    settings,
    now,
  );

  // ── 1. reconcile with the stored alerts ────────────────────────────────────
  const open = await ctx.db.select().from(adminAlerts).where(isNull(adminAlerts.resolvedAt));
  const openByKey = new Map(open.map((a) => [a.alertKey, a]));
  const findingKeys = new Set(findings.map((f) => f.key));
  for (const f of findings) {
    const existing = openByKey.get(f.key);
    if (existing) {
      await ctx.db
        .update(adminAlerts)
        .set({ lastSeenAt: now, details: f.details })
        .where(eq(adminAlerts.id, existing.id));
      continue;
    }
    const [created] = await ctx.db
      .insert(adminAlerts)
      .values({
        type: f.type,
        alertKey: f.key,
        details: f.details,
        firstSeenAt: f.since ?? now,
        lastSeenAt: now,
        createdAt: now,
      })
      .onConflictDoNothing({ target: adminAlerts.alertKey, where: isNull(adminAlerts.resolvedAt) })
      .returning();
    if (created) {
      result.opened += 1;
      openByKey.set(f.key, created);
    }
  }
  const toResolve = open.filter(
    (a) => !findingKeys.has(a.alertKey) && evaluated.has(a.type as AdminAlertType),
  );
  for (const a of toResolve) {
    await ctx.db.update(adminAlerts).set({ resolvedAt: now }).where(eq(adminAlerts.id, a.id));
    result.resolved += 1;
    openByKey.delete(a.alertKey);
  }

  // ── 2./3. mails ────────────────────────────────────────────────────────────
  let budget = settings.maxMailsPerHour - (await mailsInLastHour(ctx, now));
  const recipientsFor = (type: AdminAlertType) => recipients.filter((r) => r.types.has(type));
  const send = async (
    key: 'ADMIN_ALERT' | 'ADMIN_ALERT_RESOLVED',
    type: AdminAlertType,
    details: AlertDetails,
    since: Date,
    mark: (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<void>,
  ): Promise<'SENT' | 'DEFERRED' | 'NOBODY'> => {
    const to = recipientsFor(type);
    if (to.length === 0) return 'NOBODY';
    // Held back until the hourly budget allows all recipients (never a partial send, except when
    // the cap is lower than the number of recipients: then the cap itself is the limit).
    const need = Math.min(to.length, settings.maxMailsPerHour);
    if (budget < need) return 'DEFERRED';
    const targets = to.slice(0, need);
    const text = alertText(type, details, locale, timeZone);
    const variant = typeof details.variant === 'string' ? details.variant : 'default';
    const variables = {
      alertTitle: text.title,
      alertSummary: text.summary,
      alertSince: formatDateTime(since, locale, timeZone, 'long'),
      alertUrl: adminLink(ctx, locale, type, variant),
    };
    const ids = await withTransaction(ctx.db, async (tx) => {
      const created: string[] = [];
      for (const r of targets) {
        created.push(
          await createEmailMessage(ctx, tx, {
            key,
            to: r.email,
            locale,
            variables: { ...variables, firstName: r.displayName },
          }),
        );
      }
      await mark(tx);
      return created;
    });
    budget -= ids.length;
    for (const id of ids) await dispatchEmailMessage(ctx, id);
    return 'SENT';
  };

  const openRows = [...openByKey.values()].sort(
    (a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime(),
  );
  for (const row of openRows) {
    const type = row.type as AdminAlertType;
    if (!isAlertDue(type, row, settings, timeZone, now)) continue;
    const outcome = await send('ADMIN_ALERT', type, row.details, row.firstSeenAt, (tx) =>
      tx
        .update(adminAlerts)
        .set({ lastSentAt: now, sendCount: sql`${adminAlerts.sendCount} + 1` })
        .where(eq(adminAlerts.id, row.id))
        .then(() => undefined),
    );
    if (outcome === 'SENT') result.sent += 1;
    else result.deferred += 1;
  }

  if (settings.sendResolved) {
    const pending = await ctx.db
      .select()
      .from(adminAlerts)
      .where(
        and(
          isNotNull(adminAlerts.resolvedAt),
          isNotNull(adminAlerts.lastSentAt),
          isNull(adminAlerts.resolvedSentAt),
          gte(adminAlerts.resolvedAt, new Date(now.getTime() - RESOLVED_RETRY_MS)),
        ),
      )
      .orderBy(asc(adminAlerts.resolvedAt));
    for (const row of pending) {
      const type = row.type as AdminAlertType;
      if (!isResolvedMailAlert(type)) continue;
      const outcome = await send('ADMIN_ALERT_RESOLVED', type, row.details, row.firstSeenAt, (tx) =>
        tx
          .update(adminAlerts)
          .set({ resolvedSentAt: now })
          .where(eq(adminAlerts.id, row.id))
          .then(() => undefined),
      );
      if (outcome === 'SENT') result.resolvedMailed += 1;
      else if (outcome === 'DEFERRED') result.deferred += 1;
    }
  }

  if (result.opened || result.sent || result.resolved) {
    coreLog.info({ ...result }, 'alert cycle');
  }
  return result;
}
