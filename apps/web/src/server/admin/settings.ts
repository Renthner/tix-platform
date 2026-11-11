'use server';

import {
  clearSecretSetting,
  getMediaAsset,
  getSetting,
  hasSecretSetting,
  saveSecretSetting,
  saveSetting,
  sendTestEmail,
} from '@tix/core';
import { SCAN_RESULT_COLOR_KEYS } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { parseMoneyToCents } from '@/lib/money';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { sanitizeRichText } from '@/server/rich-text';
import { audit } from './audit';
import { fieldError, flag, success, text, zodFieldErrors } from './form';

/** Setting groups editable on /admin/settings. */
export type EditableSettingKey =
  | 'general'
  | 'branding'
  | 'checkout'
  | 'seatDisplay'
  | 'organizer'
  | 'invoicing'
  | 'bankTransfer'
  | 'paypal'
  | 'smtp'
  | 'customerAccounts'
  | 'security'
  | 'scanner';

type Errors = Partial<Record<string, FieldErrorCode>>;

/**
 * Required integer field: empty → "required" (instead of silently applying the schema default).
 * Returns undefined when invalid; the error is collected.
 */
/** Optional integer: an empty field yields null (no value), garbage is rejected. */
function optionalIntOrNull(fd: FormData, name: string, errors: Errors): number | null {
  const raw = text(fd, name);
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    errors[name] = 'invalid';
    return null;
  }
  return n;
}

function requiredInt(fd: FormData, name: string, errors: Errors): number | undefined {
  const raw = text(fd, name);
  if (raw === undefined) {
    errors[name] = 'required';
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    errors[name] = 'invalid';
    return undefined;
  }
  return n;
}

/** Secret part of a settings group (write-only in the UI: new value or "remove"). */
interface SecretChange {
  key: 'paypal.credentials' | 'smtp.credentials';
  value: Record<string, string> | null;
  clear: boolean;
}

/** Optional LOGO media asset id: empty = none; unknown id / wrong kind is rejected. */
async function logoAssetField(
  fd: FormData,
  name: string,
  errors: Errors,
): Promise<string | undefined> {
  const id = text(fd, name);
  if (id === undefined) return undefined;
  const asset = z.uuid().safeParse(id).success ? await getMediaAsset(getCore(), id) : null;
  if (!asset || asset.kind !== 'LOGO') {
    errors[name] = 'invalid';
    return undefined;
  }
  return asset.id;
}

async function readInput(
  key: EditableSettingKey,
  fd: FormData,
  errors: Errors,
): Promise<{ input: Record<string, unknown>; secret?: SecretChange }> {
  switch (key) {
    case 'general':
      return {
        input: {
          shopName: text(fd, 'shopName') ?? '',
          defaultLocale: text(fd, 'defaultLocale'),
          defaultCurrency: text(fd, 'defaultCurrency')?.toUpperCase(),
          defaultTimeZone: text(fd, 'defaultTimeZone'),
          supportEmail: text(fd, 'supportEmail'),
        },
      };
    case 'branding': {
      const logoAssetId = await logoAssetField(fd, 'logoAssetId', errors);
      const faviconAssetId = await logoAssetField(fd, 'faviconAssetId', errors);
      return {
        input: {
          logoAssetId,
          faviconAssetId,
          primaryColor: text(fd, 'primaryColor'),
          accentColor: text(fd, 'accentColor'),
          imprintUrl: text(fd, 'imprintUrl'),
          privacyUrl: text(fd, 'privacyUrl'),
          termsUrl: text(fd, 'termsUrl'),
          footerText: sanitizeRichText(text(fd, 'footerText')) || undefined,
        },
      };
    }
    case 'checkout': {
      const perCustomer = text(fd, 'maxTicketsPerCustomer');
      if (perCustomer !== undefined && !Number.isInteger(Number(perCustomer)))
        errors.maxTicketsPerCustomer = 'invalid';
      // Empty = unlimited.
      const perOrder = text(fd, 'maxTicketsPerOrder');
      if (perOrder !== undefined && !Number.isInteger(Number(perOrder)))
        errors.maxTicketsPerOrder = 'invalid';
      return {
        input: {
          cartLockTtlSeconds: requiredInt(fd, 'cartLockTtlSeconds', errors),
          paymentGraceSeconds: requiredInt(fd, 'paymentGraceSeconds', errors),
          maxTicketsPerOrder: perOrder === undefined ? null : Number(perOrder),
          maxTicketsPerCustomer: perCustomer === undefined ? null : Number(perCustomer),
          manualSeatSelectionEnabled: flag(fd, 'manualSeatSelectionEnabled'),
          bestAvailableEnabled: flag(fd, 'bestAvailableEnabled'),
          orphanSeatRuleEnabled: flag(fd, 'orphanSeatRuleEnabled'),
          companionSeatsRequireWheelchair: flag(fd, 'companionSeatsRequireWheelchair'),
          requireTermsAcceptance: flag(fd, 'requireTermsAcceptance'),
          requirePhone: flag(fd, 'requirePhone'),
          requireBillingAddress: flag(fd, 'requireBillingAddress'),
          refundFeesByDefault: flag(fd, 'refundFeesByDefault'),
        },
      };
    }
    case 'seatDisplay':
      return {
        input: {
          inOtherCartColor: text(fd, 'inOtherCartColor'),
          soldColor: text(fd, 'soldColor'),
          blockedColor: text(fd, 'blockedColor'),
          selectionColor: text(fd, 'selectionColor'),
          markUnavailableWithCross: flag(fd, 'markUnavailableWithCross'),
          selectionStyle: text(fd, 'selectionStyle'),
          seatChangeCurrentColor: text(fd, 'seatChangeCurrentColor'),
          seatChangeReplacedColor: text(fd, 'seatChangeReplacedColor'),
          seatChangeNewColor: text(fd, 'seatChangeNewColor'),
        },
      };
    case 'organizer':
      return {
        input: {
          legalName: text(fd, 'legalName'),
          street: text(fd, 'street'),
          postalCode: text(fd, 'postalCode'),
          city: text(fd, 'city'),
          country: text(fd, 'country')?.toUpperCase(),
          vatId: text(fd, 'vatId'),
          taxNumber: text(fd, 'taxNumber'),
          registerCourt: text(fd, 'registerCourt'),
          registerNumber: text(fd, 'registerNumber'),
          representatives: text(fd, 'representatives'),
          email: text(fd, 'email'),
          phone: text(fd, 'phone'),
          website: text(fd, 'website'),
        },
      };
    case 'invoicing': {
      const limit = parseMoneyToCents(text(fd, 'smallAmountInvoiceLimit') ?? '');
      if (limit === null) errors.smallAmountInvoiceLimit = 'money';
      return {
        input: {
          smallAmountInvoiceLimit: limit ?? undefined,
          issueInvoices: flag(fd, 'issueInvoices'),
          orderNumberPattern: text(fd, 'orderNumberPattern') ?? '',
          invoiceNumberPattern: text(fd, 'invoiceNumberPattern') ?? '',
          creditNoteNumberPattern: text(fd, 'creditNoteNumberPattern') ?? '',
          invoiceFooter: text(fd, 'invoiceFooter'),
        },
      };
    }
    case 'bankTransfer': {
      const tolerance = text(fd, 'autoMatchTolerance');
      const toleranceCents = tolerance === undefined ? 0 : parseMoneyToCents(tolerance);
      if (toleranceCents === null) errors.autoMatchTolerance = 'money';
      const region = text(fd, 'holidayRegion');
      return {
        input: {
          enabled: flag(fd, 'enabled'),
          paymentReferencePrefix: text(fd, 'paymentReferencePrefix')?.toUpperCase() ?? '',
          paymentTermDays: requiredInt(fd, 'paymentTermDays', errors),
          countBusinessDaysOnly: flag(fd, 'countBusinessDaysOnly'),
          holidayRegion: region ?? null,
          reminderAfterDays: requiredInt(fd, 'reminderAfterDays', errors),
          adjustmentReminderDays: requiredInt(fd, 'adjustmentReminderDays', errors),
          cancelAfterDays: optionalIntOrNull(fd, 'cancelAfterDays', errors),
          disableDaysBeforeEvent: requiredInt(fd, 'disableDaysBeforeEvent', errors),
          autoMatchToleranceCents: toleranceCents ?? undefined,
        },
      };
    }
    case 'paypal': {
      const clientSecret = text(fd, 'clientSecret');
      return {
        input: {
          enabled: flag(fd, 'enabled'),
          environment: text(fd, 'environment'),
          clientId: text(fd, 'clientId'),
          webhookId: text(fd, 'webhookId'),
          brandName: text(fd, 'brandName'),
          approvalTimeoutSeconds: requiredInt(fd, 'approvalTimeoutSeconds', errors),
        },
        secret: {
          key: 'paypal.credentials',
          value: clientSecret ? { clientSecret } : null,
          clear: flag(fd, 'clearClientSecret'),
        },
      };
    }
    case 'smtp': {
      const password = fd.get('password');
      return {
        input: {
          host: text(fd, 'host'),
          port: requiredInt(fd, 'port', errors),
          security: text(fd, 'security'),
          username: text(fd, 'username'),
          fromName: text(fd, 'fromName'),
          fromEmail: text(fd, 'fromEmail'),
          replyTo: text(fd, 'replyTo'),
          bccAddress: text(fd, 'bccAddress'),
          maxMessageSizeMb: requiredInt(fd, 'maxMessageSizeMb', errors),
        },
        secret: {
          key: 'smtp.credentials',
          // Passwords are taken verbatim (leading/trailing spaces may be significant).
          value: typeof password === 'string' && password !== '' ? { password } : null,
          clear: flag(fd, 'clearPassword'),
        },
      };
    }
    case 'security':
      return {
        input: {
          requireTwoFactor: flag(fd, 'requireTwoFactor'),
          adminSessionTtlHours: requiredInt(fd, 'adminSessionTtlHours', errors),
          minPasswordLength: requiredInt(fd, 'minPasswordLength', errors),
          maxFailedLogins: requiredInt(fd, 'maxFailedLogins', errors),
          lockoutMinutes: requiredInt(fd, 'lockoutMinutes', errors),
          inviteTtlHours: requiredInt(fd, 'inviteTtlHours', errors),
          passwordResetTtlMinutes: requiredInt(fd, 'passwordResetTtlMinutes', errors),
        },
      };
    case 'scanner':
      return {
        input: {
          allowCheckOut: flag(fd, 'allowCheckOut'),
          offlineModeAllowed: flag(fd, 'offlineModeAllowed'),
          lanSyncEnabled: flag(fd, 'lanSyncEnabled'),
          syncIntervalSeconds: requiredInt(fd, 'syncIntervalSeconds', errors),
          pairingCodeTtlMinutes: requiredInt(fd, 'pairingCodeTtlMinutes', errors),
          appUpdateSource: text(fd, 'appUpdateSource'),
          githubRepository: text(fd, 'githubRepository'),
          defaultUpdateChannel: text(fd, 'defaultUpdateChannel'),
          allowChannelOverride: flag(fd, 'allowChannelOverride'),
          serverUrl: text(fd, 'serverUrl'),
          resultColors: Object.fromEntries(
            SCAN_RESULT_COLOR_KEYS.map((k) => [k, text(fd, `resultColors.${k}`)]),
          ),
        },
      };
    case 'customerAccounts':
      return {
        input: {
          enabled: flag(fd, 'enabled'),
          guestCheckoutEnabled: flag(fd, 'guestCheckoutEnabled'),
          loginLinkEnabled: flag(fd, 'loginLinkEnabled'),
          sessionTtlDays: requiredInt(fd, 'sessionTtlDays', errors),
          passwordMinLength: requiredInt(fd, 'passwordMinLength', errors),
          emailVerificationTtlHours: requiredInt(fd, 'emailVerificationTtlHours', errors),
          passwordResetTtlMinutes: requiredInt(fd, 'passwordResetTtlMinutes', errors),
          loginLinkTtlMinutes: requiredInt(fd, 'loginLinkTtlMinutes', errors),
        },
      };
  }
}

/** Cross-field checks that need the stored secret state. */
async function checkSecretRequirements(
  key: EditableSettingKey,
  input: Record<string, unknown>,
  secret: SecretChange | undefined,
  errors: Errors,
): Promise<void> {
  if (!secret) return;
  const stored = await hasSecretSetting(getCore(), secret.key);
  const willHaveSecret = secret.value !== null || (stored && !secret.clear);
  if (key === 'paypal' && input.enabled === true) {
    if (!input.clientId) errors.clientId = 'required';
    if (!willHaveSecret) errors.clientSecret = 'secretRequired';
  }
  if (key === 'smtp' && input.username && !willHaveSecret) errors.password = 'secretRequired';
}

/** Translates schema errors of the settings registry into form error codes. */
function mapZodErrors(err: z.ZodError): Errors {
  const fields = zodFieldErrors(err);
  for (const name of ['supportEmail', 'email', 'fromEmail', 'replyTo', 'bccAddress']) {
    if (fields[name] === 'invalid') fields[name] = 'email';
  }
  for (const url of ['imprintUrl', 'privacyUrl', 'termsUrl', 'website']) {
    if (fields[url]) fields[url] = 'url';
  }
  if (fields.defaultTimeZone) fields.defaultTimeZone = 'timeZone';
  if (fields.country) fields.country = 'country';
  for (const pattern of ['orderNumberPattern', 'invoiceNumberPattern', 'creditNoteNumberPattern']) {
    if (fields[pattern] === 'invalid') fields[pattern] = 'numberPattern';
  }
  if (fields.paymentReferencePrefix) fields.paymentReferencePrefix = 'prefixFormat';
  if (fields.autoMatchToleranceCents) {
    fields.autoMatchTolerance = fields.autoMatchToleranceCents;
    delete fields.autoMatchToleranceCents;
  }
  // Refinements of the dunning terms (cancel ≥ term, reminder < cancel).
  for (const name of ['cancelAfterDays', 'reminderAfterDays']) {
    if (fields[name] === 'invalid') fields[name] = 'dunningOrder';
  }
  return fields;
}

export async function saveSettingsAction(
  key: EditableSettingKey,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const errors: Errors = {};
  const { input, secret } = await readInput(key, fd, errors);
  await checkSecretRequirements(key, input, secret, errors);
  if (Object.keys(errors).length > 0) return fieldError(errors);

  const core = getCore();
  let saved: unknown;
  try {
    saved = await saveSetting(core, key, input, session.userId);
  } catch (err) {
    if (err instanceof z.ZodError) return fieldError(mapZodErrors(err));
    throw err;
  }
  let secretChange: 'replaced' | 'removed' | null = null;
  if (secret?.value) {
    await saveSecretSetting(core, secret.key, secret.value, session.userId);
    secretChange = 'replaced';
  } else if (secret?.clear) {
    await clearSecretSetting(core, secret.key);
    secretChange = 'removed';
  }
  // Secrets themselves never reach the audit log.
  await audit(core.db, session, 'settings.update', 'system_setting', key, {
    value: saved,
    ...(secretChange ? { secret: { key: secret!.key, change: secretChange } } : {}),
  });
  revalidatePath('/', 'layout');
  return success('saved');
}

// ─── SMTP test e-mail ───────────────────────────────────────────────────────

export type TestMailState =
  | { status: 'idle' }
  | { status: 'success'; to: string; at: number }
  | { status: 'error'; code: 'email' | 'failed'; message?: string; at: number };

/** Sends the SMTP_TEST template synchronously with the saved SMTP settings. */
export async function sendTestEmailAction(
  _prev: TestMailState,
  fd: FormData,
): Promise<TestMailState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const to = text(fd, 'testRecipient') ?? session.email;
  if (!z.email().safeParse(to).success) return { status: 'error', code: 'email', at: Date.now() };
  const locale = text(fd, 'locale');
  const core = getCore();
  const result = await sendTestEmail(core, { to, locale });
  await audit(core.db, session, 'settings.smtp.test', 'system_setting', 'smtp', {
    to,
    ok: result.ok,
    messageId: result.messageId,
    ...(result.ok ? {} : { error: result.error }),
  });
  return result.ok
    ? { status: 'success', to, at: Date.now() }
    : { status: 'error', code: 'failed', message: result.error, at: Date.now() };
}
