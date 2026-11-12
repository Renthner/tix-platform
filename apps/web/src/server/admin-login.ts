import { logger } from '@/server/logger';
import 'server-only';
import {
  adminNeedsTwoFactorSetup,
  completeAdminLogin,
  isLinkedPair,
  linkCustomerForAdmin,
  writeAdminAudit,
  type AdminPasswordCheck,
} from '@tix/core';
import { hashToken } from '@tix/shared/server';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import {
  createAdminSession,
  destroyAdminSession,
  getAdminSession,
  setPendingAdminLogin,
  type AdminSession,
} from './auth';
import { getCore } from './core';
import { getCustomerSessionRecord, signInCustomer, signOutCustomer } from './customer-session';
import { clientIp } from './http';
import { readMaintenance } from './maintenance-gate';

/**
 * Shared tail of every admin sign-in (`/admin/login` and the shop's sign-in form). Not a server
 * action file on purpose: nothing exported here may be callable from the browser.
 */

type AdminPasswordOk = Extract<AdminPasswordCheck, { status: 'ok' }>;
export type LoginVia = 'admin_portal' | 'shop';

const addressOf = (ip: string) => (ip === '0.0.0.0' ? null : ip);

/** Rate-limit subject for an e-mail address (no raw address in Redis keys); shared by both forms. */
export const emailSubject = (email: string) => hashToken(email.trim().toLowerCase()).slice(0, 32);

/**
 * Gives the signed-in admin a matching customer session (own orders under "My account"),
 * capped at the admin session's expiry and tagged so it ends with the admin's access. Never
 * blocks the admin sign-in. Skipped while the forced two-factor setup is open (the required
 * second factor is not satisfied yet) and during maintenance. The core only links admins whose
 * e-mail address is verified.
 */
async function linkShopSession(
  userId: string,
  setupRequired: boolean,
  adminSessionExpiresAt: Date,
): Promise<void> {
  if (setupRequired || (await readMaintenance()).active) return;
  try {
    const linked = await linkCustomerForAdmin(getCore(), userId);
    if (linked) {
      await signInCustomer(linked.customerId, {
        linkedAdminUserId: userId,
        cap: adminSessionExpiresAt,
      });
    }
  } catch (err) {
    logger.error({ err }, '[admin-login] linking the customer account failed');
  }
}

/**
 * Password step succeeded: with two-factor only the pending cookie is set (no session of any
 * kind yet), otherwise the sign-in is completed. Returns when the code step is needed.
 */
export async function continueAdminLogin(
  admin: AdminPasswordOk,
  returnTo: string | null,
  via: LoginVia,
): Promise<'code'> {
  if (admin.twoFactor) {
    await setPendingAdminLogin(admin.userId, admin.passwordChangedAt);
    return 'code';
  }
  return finishAdminLogin(admin.userId, 'password', returnTo, via);
}

/**
 * Opens the admin session (and the linked customer session) and leaves for `returnTo`
 * (default: the admin portal; the account page while two-factor setup is still required).
 * Only call after the password – and the second factor, if enabled – succeeded.
 */
export async function finishAdminLogin(
  userId: string,
  method: 'password' | 'totp' | 'recovery_code',
  returnTo: string | null,
  via: LoginVia,
): Promise<never> {
  const ip = addressOf(await clientIp());
  const core = getCore();
  await completeAdminLogin(core, userId, ip, method, via);
  const expiresAt = await createAdminSession(userId, ip, { mfaVerified: method !== 'password' });
  const setupRequired = await adminNeedsTwoFactorSetup(core, userId);
  await linkShopSession(userId, setupRequired, expiresAt);
  const href = setupRequired ? '/admin/account' : (returnTo ?? '/admin');
  return redirect({ href, locale: await getLocale() });
}

/** Audited admin sign-out (session row + cookie). */
export async function endAdminSession(session: AdminSession): Promise<void> {
  const ip = addressOf(await clientIp());
  await writeAdminAudit(
    getCore().db,
    { userId: session.userId, ipAddress: ip },
    'admin_user.logout',
    session.userId,
  );
  await destroyAdminSession();
}

/**
 * Ends the customer session that belongs to the admin: the one with the admin's e-mail
 * address, or – when the admin session is already gone (`adminEmail` null) – one that was
 * created by linking an admin.
 */
export async function endLinkedCustomerSession(adminEmail: string | null): Promise<void> {
  const customer = await getCustomerSessionRecord();
  if (!customer) return;
  const linked = adminEmail
    ? isLinkedPair(adminEmail, customer.email)
    : customer.linkedAdminUserId !== null;
  if (linked) await signOutCustomer();
}

/** Sign-out from the shop header's dashboard menu: always ends the admin session (+ linked customer). */
export async function signOutAdminFromShop(): Promise<void> {
  const admin = await getAdminSession();
  await endLinkedCustomerSession(admin?.email ?? null);
  if (admin) await endAdminSession(admin);
  else await destroyAdminSession();
}

/**
 * Shop sign-out: the customer session always ends; a signed-in admin of the same person (or
 * an admin session without any customer session, e.g. accounts switched off) ends with it.
 */
export async function signOutShop(): Promise<void> {
  const [customer, admin] = await Promise.all([getCustomerSessionRecord(), getAdminSession()]);
  await signOutCustomer();
  if (admin && (!customer || isLinkedPair(admin.email, customer.email))) {
    await endAdminSession(admin);
  }
}
