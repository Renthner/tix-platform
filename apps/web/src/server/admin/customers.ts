'use server';

import {
  DomainError,
  anonymizeCustomer,
  getCustomerAdminView,
  removeCustomerLogin,
  requestPasswordReset,
  saveSetting,
  sendEmailVerification,
  unlockCustomerAccount,
  updateCustomerAsAdmin,
} from '@tix/core';
import { SUPPORTED_LOCALES, type AppLocale } from '@tix/shared';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { clientIp } from '@/server/http';
import { audit } from './audit';
import { text } from './form';

/**
 * Admin actions on customers. Results carry stable codes translated in the UI
 * (`customers.messages.*` / `customers.errors.*`).
 */
export type CustomerActionState =
  | { status: 'idle' }
  | { status: 'success'; message: string; at: number }
  | { status: 'error'; code: string; at: number; fields?: string[] };

const ok = (message: string): CustomerActionState => ({
  status: 'success',
  message,
  at: Date.now(),
});
const fail = (code: string, fields?: string[]): CustomerActionState => ({
  status: 'error',
  code,
  at: Date.now(),
  ...(fields ? { fields } : {}),
});

async function run(
  customerId: string,
  fn: () => Promise<CustomerActionState>,
): Promise<CustomerActionState> {
  if (!z.uuid().safeParse(customerId).success) return fail('CUSTOMER_NOT_FOUND');
  try {
    const result = await fn();
    revalidatePath('/[locale]/admin/customers', 'layout');
    revalidatePath('/[locale]/admin/orders', 'layout');
    return result;
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code);
    console.error('[admin/customers] action failed', err);
    return fail('INTERNAL_ERROR');
  }
}

async function actorOf(session: { userId: string }) {
  const ip = await clientIp();
  return { userId: session.userId, ipAddress: ip === '0.0.0.0' ? null : ip };
}

const toLocale = (value: string | null | undefined, fallback: string): AppLocale =>
  ((SUPPORTED_LOCALES as readonly string[]).includes(value ?? '')
    ? value
    : (SUPPORTED_LOCALES as readonly string[]).includes(fallback)
      ? fallback
      : 'en') as AppLocale;

export async function updateCustomerAction(
  customerId: string,
  _prev: CustomerActionState,
  fd: FormData,
): Promise<CustomerActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(customerId, async () => {
    const street = text(fd, 'street');
    const addressLine2 = text(fd, 'addressLine2');
    const postalCode = text(fd, 'postalCode');
    const city = text(fd, 'city');
    const country = text(fd, 'country')?.toUpperCase();
    const hasAddress = Boolean(street || addressLine2 || postalCode || city);
    try {
      await updateCustomerAsAdmin(getCore(), await actorOf(session), customerId, {
        firstName: text(fd, 'firstName') ?? '',
        lastName: text(fd, 'lastName') ?? '',
        email: text(fd, 'email') ?? '',
        company: text(fd, 'company') ?? null,
        phone: text(fd, 'phone') ?? null,
        address: hasAddress
          ? {
              street: street ?? '',
              addressLine2,
              postalCode: postalCode ?? '',
              city: city ?? '',
              country: country ?? '',
            }
          : null,
        locale: (text(fd, 'locale') as AppLocale | undefined) ?? null,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return fail('VALIDATION', [...new Set(err.issues.map((i) => String(i.path[0] ?? '_')))]);
      }
      throw err;
    }
    return ok('saved');
  });
}

export type CustomerAccountOperation =
  'resendVerification' | 'sendPasswordReset' | 'unlock' | 'removeLogin';

/** Single-button account operations. */
export async function customerAccountAction(
  customerId: string,
  operation: CustomerAccountOperation,
): Promise<CustomerActionState> {
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  return run(customerId, async () => {
    const core = getCore();
    const actor = await actorOf(session);
    const view = await getCustomerAdminView(core, customerId);
    if (!view) return fail('CUSTOMER_NOT_FOUND');
    if (view.customer.anonymizedAt) return fail('CUSTOMER_ANONYMIZED');
    const locale = toLocale(view.customer.locale, await getLocale());
    switch (operation) {
      case 'resendVerification': {
        if (!view.customer.hasAccount) return fail('ACCOUNT_REQUIRED');
        const { alreadyVerified } = await sendEmailVerification(core, customerId, { locale });
        await audit(core.db, session, 'customer.resend_verification', 'customer', customerId);
        return ok(alreadyVerified ? 'alreadyVerified' : 'verificationSent');
      }
      case 'sendPasswordReset':
        if (!view.customer.hasAccount) return fail('ACCOUNT_REQUIRED');
        await requestPasswordReset(core, { email: view.customer.email, locale });
        await audit(core.db, session, 'customer.send_password_reset', 'customer', customerId);
        return ok('passwordResetSent');
      case 'unlock':
        await unlockCustomerAccount(core, actor, customerId);
        return ok('unlocked');
      case 'removeLogin':
        await removeCustomerLogin(core, actor, customerId);
        return ok('loginRemoved');
    }
  });
}

/** GDPR Art. 17: password re-confirmation + the customer's e-mail address typed as confirmation. */
export async function anonymizeCustomerAction(
  customerId: string,
  _prev: CustomerActionState,
  fd: FormData,
): Promise<CustomerActionState> {
  const session = await requireAdmin(['FINANCE']);
  return run(customerId, async () => {
    const core = getCore();
    const view = await getCustomerAdminView(core, customerId);
    if (!view) return fail('CUSTOMER_NOT_FOUND');
    const typed = text(fd, 'confirm')?.toLowerCase();
    if (!typed || typed !== view.customer.email.toLowerCase()) return fail('CONFIRM_MISMATCH');
    const password = fd.get('password');
    if (typeof password !== 'string' || password === '') return fail('WRONG_PASSWORD');
    await anonymizeCustomer(core, await actorOf(session), customerId, { password });
    return ok('anonymized');
  });
}

/** Retention periods (SUPER_ADMIN). */
export async function savePrivacySettingsAction(
  _prev: CustomerActionState,
  fd: FormData,
): Promise<CustomerActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const days = text(fd, 'emailRetentionDays');
  const years = text(fd, 'invoiceRetentionYears');
  const hooks = text(fd, 'webhookRetentionDays');
  if (days === undefined || years === undefined || hooks === undefined)
    return fail('VALIDATION', ['retention']);
  try {
    const core = getCore();
    const saved = await saveSetting(
      core,
      'privacy',
      {
        emailRetentionDays: Number(days),
        invoiceRetentionYears: Number(years),
        webhookRetentionDays: Number(hooks),
      },
      session.userId,
    );
    await audit(core.db, session, 'settings.update', 'system_setting', 'privacy', { value: saved });
    revalidatePath('/[locale]/admin/customers', 'layout');
    return ok('settingsSaved');
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(
        'VALIDATION',
        err.issues.map((i) => String(i.path[0] ?? '_')),
      );
    }
    throw err;
  }
}
