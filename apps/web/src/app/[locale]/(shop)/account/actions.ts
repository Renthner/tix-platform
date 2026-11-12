'use server';

import { logger } from '@/server/logger';
import {
  DomainError,
  changeCustomerPassword,
  checkSharedLogin,
  consumeLoginLink,
  customerEmailSchema,
  customerProfileSchema,
  getSetting,
  registerCustomerSchema,
  registerCustomer,
  requestLoginLink,
  requestPasswordReset,
  resetCustomerPassword,
  safeReturnPath,
  sendEmailVerification,
  updateCustomerProfile,
  verifyAdminPassword,
} from '@tix/core';
import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from '@tix/shared';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import type {
  AccountFieldError,
  AccountFormError,
  AccountFormMessage,
  AccountFormState,
  AccountFormValues,
} from '@/lib/account-form';
import { continueAdminLogin, emailSubject, signOutShop } from '@/server/admin-login';
import { assertNotInMaintenance } from '@/server/maintenance-assert';
import { getCore } from '@/server/core';
import {
  getCustomerSessionRecord,
  readCustomerSessionToken,
  signInCustomer,
} from '@/server/customer-session';
import { clientIp, enforceRateLimit } from '@/server/http';

type FieldErrors = Partial<Record<string, AccountFieldError>>;

const MINUTE = 60_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────────────

function str(fd: FormData, name: string): string {
  const value = fd.get(name);
  return typeof value === 'string' ? value : '';
}

async function currentLocale(): Promise<AppLocale> {
  const locale = await getLocale();
  return isAppLocale(locale) ? locale : DEFAULT_LOCALE;
}

const fail = (
  error: AccountFormError,
  extra: { fieldErrors?: FieldErrors; values?: AccountFormValues } = {},
): AccountFormState => ({ status: 'error', error, ...extra, at: Date.now() });

const ok = (message: AccountFormMessage, values?: AccountFormValues): AccountFormState => ({
  status: 'success',
  message,
  ...(values ? { values } : {}),
  at: Date.now(),
});

/** Runs the rate-limit checks; returns a RATE_LIMITED state when one is exceeded. */
async function limited(
  checks: [bucket: string, subject: string, max: number, windowMs: number][],
): Promise<AccountFormState | null> {
  try {
    for (const [bucket, subject, max, windowMs] of checks) {
      await enforceRateLimit(bucket, subject, max, windowMs);
    }
    return null;
  } catch (err) {
    if (err instanceof DomainError && err.code === 'RATE_LIMITED') return fail('RATE_LIMITED');
    throw err;
  }
}

const mailLimits = (ip: string, email: string): Parameters<typeof limited>[0] => [
  ['customer-mail-ip', ip, 10, 15 * MINUTE],
  ['customer-mail-email', emailSubject(email), 5, 60 * MINUTE],
];

/** Zod issues → field error codes (address fields are keyed by their own name). */
function zodFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path.at(-1) ?? '_');
    if (out[key]) continue;
    if (issue.code === 'too_small') {
      out[key] = issue.origin === 'string' && issue.minimum === 1 ? 'required' : 'invalid';
    } else if (issue.code === 'too_big') {
      out[key] = 'tooLong';
    } else if (issue.code === 'invalid_type' && issue.input === undefined) {
      out[key] = 'required';
    } else if (key === 'email') {
      out[key] = 'email';
    } else if (key === 'country') {
      out[key] = 'country';
    } else {
      out[key] = 'invalid';
    }
  }
  return out;
}

/** Password policy checks shown together with the other field errors. */
async function passwordErrors(
  password: string,
  confirm: string,
  field: string,
): Promise<{ fieldErrors: FieldErrors; min: number }> {
  const { passwordMinLength: min } = await getSetting(getCore(), 'customerAccounts');
  const fieldErrors: FieldErrors = {};
  if (password.length === 0) fieldErrors[field] = 'required';
  else if ([...password].length < min) fieldErrors[field] = 'passwordTooShort';
  else if (password.length > 1_024) fieldErrors[field] = 'tooLong';
  if (password.length > 0 && confirm !== password)
    fieldErrors[`${field}Confirm`] = 'passwordMismatch';
  return { fieldErrors, min };
}

/** Domain / validation errors → form state; WEAK_PASSWORD is attached to `passwordField`. */
function fromError(err: unknown, passwordField = 'password'): AccountFormState {
  if (err instanceof DomainError) {
    switch (err.code) {
      case 'WEAK_PASSWORD':
        return fail('VALIDATION_FAILED', {
          fieldErrors: { [passwordField]: 'passwordTooShort' },
          values: { min: Number(err.details?.min ?? 0) },
        });
      case 'PASSWORD_TOO_LONG':
        return fail('VALIDATION_FAILED', { fieldErrors: { [passwordField]: 'tooLong' } });
      case 'ACCOUNT_LOCKED':
        return fail('ACCOUNT_LOCKED', { values: { minutes: Number(err.details?.minutes ?? 0) } });
      case 'CURRENT_PASSWORD_INVALID':
        return fail('CURRENT_PASSWORD_INVALID', { fieldErrors: { currentPassword: 'invalid' } });
      case 'CUSTOMER_NOT_FOUND':
        return fail('SESSION_EXPIRED');
      case 'INVALID_CREDENTIALS':
      case 'RATE_LIMITED':
      case 'TOKEN_INVALID':
      case 'ACCOUNTS_DISABLED':
      case 'LOGIN_LINK_DISABLED':
        return fail(err.code);
    }
  }
  if (err instanceof z.ZodError) {
    return fail('VALIDATION_FAILED', { fieldErrors: zodFieldErrors(err) });
  }
  logger.error({ err }, '[account] unexpected error');
  return fail('GENERIC');
}

// ─── Sign in ──────────────────────────────────────────────────────────────────────────

/** Password sign-in, or (intent "link") a passwordless sign-in link by e-mail. */
export async function loginAction(
  _prev: AccountFormState,
  fd: FormData,
): Promise<AccountFormState> {
  await assertNotInMaintenance();
  const next = safeReturnPath(str(fd, 'next'));
  const rawEmail = str(fd, 'email');
  const email = customerEmailSchema.safeParse(rawEmail);
  if (!email.success) {
    return fail('VALIDATION_FAILED', {
      fieldErrors: { email: rawEmail.trim() ? 'email' : 'required' },
    });
  }
  const ip = await clientIp();
  const locale = await currentLocale();
  const core = getCore();

  if (str(fd, 'intent') === 'link') {
    const blocked = await limited(mailLimits(ip, email.data));
    if (blocked) return blocked;
    try {
      await requestLoginLink(core, { email: email.data, locale, returnPath: next });
    } catch (err) {
      return fromError(err);
    }
    const { loginLinkTtlMinutes } = await getSetting(core, 'customerAccounts');
    return ok('linkSent', { email: email.data, minutes: loginLinkTtlMinutes });
  }

  const password = str(fd, 'password');
  if (!password) return fail('VALIDATION_FAILED', { fieldErrors: { password: 'required' } });
  // The form also signs in admin accounts, so the admin sign-in limits apply as well.
  const blocked = await limited([
    ['customer-login-ip', ip, 20, 15 * MINUTE],
    ['customer-login-email', emailSubject(email.data), 10, 15 * MINUTE],
    ['admin-login-ip', ip, 20, 15 * MINUTE],
    ['admin-login-email', emailSubject(email.data), 10, 15 * MINUTE],
  ]);
  if (blocked) return blocked;
  let result: Awaited<ReturnType<typeof checkSharedLogin>>;
  try {
    result = await checkSharedLogin(
      core,
      { email: email.data, password },
      ip === '0.0.0.0' ? null : ip,
    );
    if (result.kind === 'customer') {
      await signInCustomer(result.customerId, { requirePasswordHash: result.passwordHash });
    }
  } catch (err) {
    return fromError(err);
  }
  if (result.kind === 'invalid') return fromError(result.error);
  if (result.kind === 'admin') {
    // Same path as /admin/login: without two-factor this redirects (and opens both sessions);
    // with two-factor only the pending cookie is set and the code step follows. (Outside the
    // try block above: the redirect is an exception.)
    await continueAdminLogin(result.admin, next ?? '/', 'shop');
    return { status: 'twoFactor', at: Date.now() };
  }
  return redirect({ href: next ?? '/account', locale });
}

/** Landing page of a login link: the button press consumes the single-use token. */
export async function loginLinkAction(
  _prev: AccountFormState,
  fd: FormData,
): Promise<AccountFormState> {
  await assertNotInMaintenance();
  const next = safeReturnPath(str(fd, 'next'));
  const locale = await currentLocale();
  const blocked = await limited([['customer-token-ip', await clientIp(), 30, 15 * MINUTE]]);
  if (blocked) return blocked;
  try {
    const { customerId } = await consumeLoginLink(getCore(), str(fd, 'token'));
    await signInCustomer(customerId);
  } catch (err) {
    return fromError(err);
  }
  return redirect({ href: next ?? '/account', locale });
}

export async function signOutAction(): Promise<void> {
  await signOutShop();
  redirect({ href: '/', locale: await currentLocale() });
}

// ─── Registration & password reset ────────────────────────────────────────────────────

export async function registerAction(
  _prev: AccountFormState,
  fd: FormData,
): Promise<AccountFormState> {
  await assertNotInMaintenance();
  const input = {
    firstName: str(fd, 'firstName'),
    lastName: str(fd, 'lastName'),
    email: str(fd, 'email'),
    password: str(fd, 'password'),
    locale: await currentLocale(),
    returnPath: safeReturnPath(str(fd, 'next')),
  };
  const parsed = registerCustomerSchema.safeParse(input);
  const policy = await passwordErrors(input.password, str(fd, 'passwordConfirm'), 'password');
  const fieldErrors = {
    ...(parsed.success ? {} : zodFieldErrors(parsed.error)),
    ...policy.fieldErrors,
  };
  if (!parsed.success || Object.keys(fieldErrors).length > 0) {
    return fail('VALIDATION_FAILED', { fieldErrors, values: { min: policy.min } });
  }
  const ip = await clientIp();
  const blocked = await limited([
    ['customer-register-ip', ip, 10, 60 * MINUTE],
    ...mailLimits(ip, parsed.data.email),
  ]);
  if (blocked) return blocked;
  try {
    await registerCustomer(getCore(), parsed.data);
  } catch (err) {
    return fromError(err);
  }
  return ok('registered', { email: parsed.data.email });
}

export async function forgotPasswordAction(
  _prev: AccountFormState,
  fd: FormData,
): Promise<AccountFormState> {
  await assertNotInMaintenance();
  const rawEmail = str(fd, 'email');
  const email = customerEmailSchema.safeParse(rawEmail);
  if (!email.success) {
    return fail('VALIDATION_FAILED', {
      fieldErrors: { email: rawEmail.trim() ? 'email' : 'required' },
    });
  }
  const blocked = await limited(mailLimits(await clientIp(), email.data));
  if (blocked) return blocked;
  const core = getCore();
  try {
    await requestPasswordReset(core, {
      email: email.data,
      locale: await currentLocale(),
      returnPath: safeReturnPath(str(fd, 'next')),
    });
  } catch (err) {
    return fromError(err);
  }
  const { passwordResetTtlMinutes } = await getSetting(core, 'customerAccounts');
  return ok('resetSent', { email: email.data, minutes: passwordResetTtlMinutes });
}

export async function resetPasswordAction(
  _prev: AccountFormState,
  fd: FormData,
): Promise<AccountFormState> {
  await assertNotInMaintenance();
  const password = str(fd, 'password');
  const policy = await passwordErrors(password, str(fd, 'passwordConfirm'), 'password');
  if (Object.keys(policy.fieldErrors).length > 0) {
    return fail('VALIDATION_FAILED', {
      fieldErrors: policy.fieldErrors,
      values: { min: policy.min },
    });
  }
  const next = safeReturnPath(str(fd, 'next'));
  const locale = await currentLocale();
  const blocked = await limited([['customer-token-ip', await clientIp(), 30, 15 * MINUTE]]);
  if (blocked) return blocked;
  try {
    const { customerId } = await resetCustomerPassword(getCore(), {
      token: str(fd, 'token'),
      password,
    });
    await signInCustomer(customerId);
  } catch (err) {
    return fromError(err);
  }
  return redirect({ href: next ?? '/account?passwordReset=1', locale });
}

// ─── Signed-in account ────────────────────────────────────────────────────────────────

export async function resendVerificationAction(
  _prev: AccountFormState,
  fd: FormData,
): Promise<AccountFormState> {
  await assertNotInMaintenance();
  const session = await getCustomerSessionRecord();
  if (!session) return fail('SESSION_EXPIRED');
  const blocked = await limited(mailLimits(await clientIp(), session.email));
  if (blocked) return blocked;
  try {
    const result = await sendEmailVerification(getCore(), session.customerId, {
      locale: await currentLocale(),
      returnPath: safeReturnPath(str(fd, 'next')),
    });
    return result.alreadyVerified
      ? ok('alreadyVerified')
      : ok('verificationSent', { email: session.email });
  } catch (err) {
    return fromError(err);
  }
}

export async function updateProfileAction(
  _prev: AccountFormState,
  fd: FormData,
): Promise<AccountFormState> {
  await assertNotInMaintenance();
  const session = await getCustomerSessionRecord();
  if (!session) return fail('SESSION_EXPIRED');
  const address = {
    street: str(fd, 'street').trim(),
    addressLine2: str(fd, 'addressLine2').trim(),
    postalCode: str(fd, 'postalCode').trim(),
    city: str(fd, 'city').trim(),
    country: str(fd, 'country').trim().toUpperCase(),
  };
  // The address is optional – but if any line is filled in, it must be complete.
  const hasAddress = [address.street, address.addressLine2, address.postalCode, address.city].some(
    Boolean,
  );
  const parsed = customerProfileSchema.safeParse({
    firstName: str(fd, 'firstName'),
    lastName: str(fd, 'lastName'),
    phone: str(fd, 'phone'),
    address: hasAddress ? { ...address, addressLine2: address.addressLine2 || undefined } : null,
  });
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', { fieldErrors: zodFieldErrors(parsed.error) });
  }
  try {
    await updateCustomerProfile(getCore(), session.customerId, parsed.data);
  } catch (err) {
    return fromError(err);
  }
  return ok('profileSaved');
}

export async function changePasswordAction(
  _prev: AccountFormState,
  fd: FormData,
): Promise<AccountFormState> {
  await assertNotInMaintenance();
  const session = await getCustomerSessionRecord();
  if (!session) return fail('SESSION_EXPIRED');
  const currentPassword = str(fd, 'currentPassword');
  const newPassword = str(fd, 'newPassword');
  const policy = await passwordErrors(newPassword, str(fd, 'newPasswordConfirm'), 'newPassword');
  const fieldErrors: FieldErrors = { ...policy.fieldErrors };
  // A session created by linking an admin has no customer password: setting one needs proof
  // of ownership (the admin password), otherwise a stolen session could take the account over.
  const adminConfirm = !session.hasPassword && session.linkedAdminUserId !== null;
  if ((session.hasPassword || adminConfirm) && !currentPassword) {
    fieldErrors.currentPassword = 'required';
  }
  if (Object.keys(fieldErrors).length > 0) {
    return fail('VALIDATION_FAILED', { fieldErrors, values: { min: policy.min } });
  }
  const blocked = await limited([['customer-password', session.customerId, 10, 15 * MINUTE]]);
  if (blocked) return blocked;
  try {
    if (adminConfirm) {
      await verifyAdminPassword(getCore(), session.linkedAdminUserId!, currentPassword).catch(
        (err: unknown) => {
          if (err instanceof DomainError && err.code === 'WRONG_PASSWORD') {
            throw new DomainError('CURRENT_PASSWORD_INVALID', 'The password is not correct', 422);
          }
          throw err;
        },
      );
    }
    await changeCustomerPassword(
      getCore(),
      session.customerId,
      { currentPassword: session.hasPassword ? currentPassword : null, newPassword },
      { keepSessionToken: await readCustomerSessionToken() },
    );
  } catch (err) {
    return fromError(err, 'newPassword');
  }
  return ok('passwordChanged');
}
