import { adminUsers, emailMessages, events, seatMaps } from '@tix/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { CoreContext } from './context';
import { paymentAvailabilityForEvents } from './orders/pricing';
import { resolveScannerServerUrl } from './scanner/devices';
import { getSetting } from './settings';

/**
 * "First steps" checklist of the admin dashboard. `loadSetupFacts` gathers cheap facts (settings,
 * exists-queries); `buildSetupChecklist` is pure and turns them into the step list.
 */

export const SETUP_STEP_KEYS = [
  'organizer',
  'email',
  'payment',
  'scanner',
  'venue',
  'event',
  'backups',
  'twoFactor',
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export interface SetupFacts {
  organizer: {
    legalName?: string;
    street?: string;
    postalCode?: string;
    city?: string;
    email?: string;
  };
  /** At least one e-mail (the SMTP test mail included) was delivered. */
  emailSent: boolean;
  /** Same availability rules as the checkout: a method counts when it would be offered. */
  paypalUsable: boolean;
  bankTransferUsable: boolean;
  /** Bank transfer is switched on but has no active default receiving account. */
  bankAccountMissing: boolean;
  /** Result of `resolveScannerServerUrl`: the URL (explicit or the public APP_URL) is not localhost. */
  scannerServerUrl: { explicit: boolean; reachableFromPhone: boolean };
  hasSeatPlan: boolean;
  hasPublishedEvent: boolean;
  backupScheduleEnabled: boolean;
  backupExternalEnabled: boolean;
  twoFactorEnabled: boolean;
}

export interface SetupStep {
  key: SetupStepKey;
  done: boolean;
  /** Admin path (locale-less) where the step is completed. */
  href: string;
  /** Optional hint shown with the step. */
  hint?: 'externalBackup';
}

export interface SetupChecklist {
  steps: SetupStep[];
  doneCount: number;
  total: number;
  allDone: boolean;
}

const filled = (value: string | undefined): boolean => (value ?? '').trim() !== '';

export function buildSetupChecklist(f: SetupFacts): SetupChecklist {
  const o = f.organizer;
  const steps: SetupStep[] = [
    {
      key: 'organizer',
      done:
        filled(o.legalName) &&
        filled(o.street) &&
        filled(o.postalCode) &&
        filled(o.city) &&
        filled(o.email),
      href: '/admin/settings/organizer',
    },
    { key: 'email', done: f.emailSent, href: '/admin/settings/email' },
    {
      key: 'payment',
      done: f.paypalUsable || f.bankTransferUsable,
      href: f.bankAccountMissing ? '/admin/banking/accounts' : '/admin/settings/payments',
    },
    {
      key: 'scanner',
      done: f.scannerServerUrl.reachableFromPhone,
      href: '/admin/settings/scanner',
    },
    { key: 'venue', done: f.hasSeatPlan, href: '/admin/venues' },
    { key: 'event', done: f.hasPublishedEvent, href: '/admin/events' },
    {
      key: 'backups',
      done: f.backupScheduleEnabled,
      href: '/admin/backups',
      ...(f.backupScheduleEnabled && !f.backupExternalEnabled
        ? { hint: 'externalBackup' as const }
        : {}),
    },
    { key: 'twoFactor', done: f.twoFactorEnabled, href: '/admin/account' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: steps.length, allDone: doneCount === steps.length };
}

const exists = async (query: PromiseLike<unknown[]>): Promise<boolean> => (await query).length > 0;

export async function loadSetupFacts(ctx: CoreContext, userId: string): Promise<SetupFacts> {
  const db = ctx.db;
  // One synthetic event that inherits every setting → exactly the checkout rules for a default
  // event (far in the future so "too close to the event" never applies).
  const inheritingEvent = {
    startsAt: new Date(Date.now() + 5 * 365 * 86_400_000),
    bankTransferEnabled: null,
    bankTransferDisableDaysBeforeEvent: null,
    paypalEnabled: null,
  };
  const [organizer, emailSent, availability, scanner, hasSeatPlan, hasPublishedEvent, backup, tfa] =
    await Promise.all([
      getSetting(ctx, 'organizer'),
      exists(
        db
          .select({ id: emailMessages.id })
          .from(emailMessages)
          .where(eq(emailMessages.status, 'SENT'))
          .limit(1),
      ),
      paymentAvailabilityForEvents(ctx, [inheritingEvent]),
      resolveScannerServerUrl(ctx),
      exists(
        db.select({ id: seatMaps.id }).from(seatMaps).where(eq(seatMaps.kind, 'TEMPLATE')).limit(1),
      ),
      exists(
        db.select({ id: events.id }).from(events).where(eq(events.status, 'PUBLISHED')).limit(1),
      ),
      getSetting(ctx, 'backup'),
      exists(
        db
          .select({ id: adminUsers.id })
          .from(adminUsers)
          .where(and(eq(adminUsers.id, userId), isNotNull(adminUsers.totpSecretEncrypted)))
          .limit(1),
      ),
    ]);
  return {
    organizer,
    emailSent,
    paypalUsable: availability.PAYPAL === null,
    bankTransferUsable: availability.BANK_TRANSFER === null,
    bankAccountMissing: availability.BANK_TRANSFER === 'NOT_CONFIGURED',
    scannerServerUrl: {
      explicit: scanner.explicit,
      reachableFromPhone: scanner.reachableFromPhone,
    },
    hasSeatPlan,
    hasPublishedEvent,
    backupScheduleEnabled: backup.scheduleEnabled,
    backupExternalEnabled: backup.externalEnabled,
    twoFactorEnabled: tfa,
  };
}

/** Checklist for the dashboard, or null once dismissed (the caller hides it when `allDone`). */
export async function getSetupChecklist(
  ctx: CoreContext,
  userId: string,
): Promise<SetupChecklist | null> {
  if ((await getSetting(ctx, 'setupChecklist')).dismissed) return null;
  return buildSetupChecklist(await loadSetupFacts(ctx, userId));
}
