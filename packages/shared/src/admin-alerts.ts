import { z } from 'zod';
import type { AdminRole } from './enums';

/**
 * Warning e-mails to admins ("alerts"). The types, who may receive which type and the defaults
 * live here so the worker (sending), the web app (profile page) and the tests agree.
 */
export const ADMIN_ALERT_TYPES = [
  'BACKUP_FAILED',
  'BACKUP_OVERDUE',
  'DISK_LOW',
  'JOBS_FAILING',
  'EMAIL_DELIVERY_FAILING',
  'REVIEW_CASES_OPEN',
  'BANK_SYNC_FAILING',
  'PAYMENT_PROVIDER_ERRORS',
  'REFUNDS_OPEN',
  'PAID_CANCELLED_EVENT',
  'UPDATE_AVAILABLE',
] as const;
export type AdminAlertType = (typeof ADMIN_ALERT_TYPES)[number];

/** `SYSTEM` alerts concern the installation (the System page is SUPER_ADMIN only), `FINANCE` alerts money. */
export const ADMIN_ALERT_GROUPS = ['SYSTEM', 'FINANCE'] as const;
export type AdminAlertGroup = (typeof ADMIN_ALERT_GROUPS)[number];

export const ALERT_TYPE_GROUP: Record<AdminAlertType, AdminAlertGroup> = {
  BACKUP_FAILED: 'SYSTEM',
  BACKUP_OVERDUE: 'SYSTEM',
  DISK_LOW: 'SYSTEM',
  JOBS_FAILING: 'SYSTEM',
  EMAIL_DELIVERY_FAILING: 'SYSTEM',
  UPDATE_AVAILABLE: 'SYSTEM',
  REVIEW_CASES_OPEN: 'FINANCE',
  BANK_SYNC_FAILING: 'FINANCE',
  PAYMENT_PROVIDER_ERRORS: 'FINANCE',
  REFUNDS_OPEN: 'FINANCE',
  PAID_CANCELLED_EVENT: 'FINANCE',
};

/** Digest alerts are sent once a day (at the digest time) while the condition holds; they have no "resolved" mail. */
export const DIGEST_ALERT_TYPES: readonly AdminAlertType[] = ['REVIEW_CASES_OPEN', 'REFUNDS_OPEN'];
export const isDigestAlert = (type: AdminAlertType): boolean => DIGEST_ALERT_TYPES.includes(type);

/** Mailed once per occurrence (a new version is a new occurrence), never repeated after the cooldown. */
export const ONCE_ALERT_TYPES: readonly AdminAlertType[] = ['UPDATE_AVAILABLE'];

/** Alerts that clear by themselves without a "resolved" mail (digests, update notices). */
export const isResolvedMailAlert = (type: AdminAlertType): boolean =>
  !isDigestAlert(type) && !ONCE_ALERT_TYPES.includes(type);

/** Off unless an admin switches it on. */
export const OPT_IN_ALERT_TYPES: readonly AdminAlertType[] = ['UPDATE_AVAILABLE'];

const FINANCE_ROLES: readonly AdminRole[] = ['SUPER_ADMIN', 'FINANCE'];

/** Alert types a user with these roles may ever receive (re-checked at send time). */
export function selectableAlertTypes(roles: readonly AdminRole[]): AdminAlertType[] {
  const system = roles.includes('SUPER_ADMIN');
  const finance = roles.some((r) => FINANCE_ROLES.includes(r));
  return ADMIN_ALERT_TYPES.filter((t) => (ALERT_TYPE_GROUP[t] === 'SYSTEM' ? system : finance));
}

/** Role defaults: SUPER_ADMIN everything except opt-in types, FINANCE the finance group, others nothing. */
export function defaultAlertTypes(roles: readonly AdminRole[]): AdminAlertType[] {
  const selectable = selectableAlertTypes(roles);
  if (roles.includes('SUPER_ADMIN'))
    return selectable.filter((t) => !OPT_IN_ALERT_TYPES.includes(t));
  if (roles.includes('FINANCE')) return selectable.filter((t) => ALERT_TYPE_GROUP[t] === 'FINANCE');
  return [];
}

/** Stored in `admin_users.alert_preferences`; NULL = role defaults. */
export const alertPreferencesSchema = z.object({
  types: z.array(z.enum(ADMIN_ALERT_TYPES)).max(ADMIN_ALERT_TYPES.length),
});
export type AlertPreferences = z.infer<typeof alertPreferencesSchema>;

/** Types a user receives: their choice (when valid) limited to what the roles allow, else the defaults. */
export function effectiveAlertTypes(
  roles: readonly AdminRole[],
  preferences: unknown,
): AdminAlertType[] {
  const selectable = new Set(selectableAlertTypes(roles));
  const parsed = alertPreferencesSchema.safeParse(preferences);
  if (!parsed.success) return defaultAlertTypes(roles);
  return ADMIN_ALERT_TYPES.filter((t) => selectable.has(t) && parsed.data.types.includes(t));
}
