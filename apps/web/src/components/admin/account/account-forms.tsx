'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ErrorAlert } from '@/components/admin/auth/password-link-forms';
import { ActionForm, Field, SubmitButton } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SECURITY_IDLE, type SecurityState } from '@/lib/security-state';
import type { TotpSetup } from '@tix/core';
import { ADMIN_ALERT_GROUPS, ALERT_TYPE_GROUP, type AdminAlertType } from '@tix/shared';

type Action = (state: SecurityState, fd: FormData) => Promise<SecurityState>;

/** Toast with the success message of an action state (once per result). */
export function useSuccessToast(state: SecurityState) {
  const t = useTranslations('adminSecurity.messages');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status !== 'success' || state.at === last.current) return;
    last.current = state.at;
    if (state.message) toast.success(t(state.message as 'profileSaved'));
  }, [state, t]);
}

export function ProfileForm({
  action,
  displayName,
  email,
}: {
  action: Action;
  displayName: string;
  email: string;
}) {
  const t = useTranslations('adminSecurity.account.profile');
  const [state, formAction] = useActionState(action, SECURITY_IDLE);
  useSuccessToast(state);
  return (
    <ActionForm action={formAction} className="max-w-md space-y-4">
      <ErrorAlert state={state} />
      <Field label={t('email')} htmlFor="account-email">
        <Input id="account-email" value={email} readOnly disabled />
      </Field>
      <Field label={t('displayName')} htmlFor="displayName">
        <Input
          id="displayName"
          name="displayName"
          defaultValue={displayName}
          maxLength={120}
          required
        />
      </Field>
      <SubmitButton>{t('save')}</SubmitButton>
    </ActionForm>
  );
}

/** Confirm the own e-mail address: sends a one-time link (unlocks "My account" in the shop). */
export function EmailVerifyForm({
  action,
  verified,
  email,
}: {
  action: Action;
  verified: boolean;
  email: string;
}) {
  const t = useTranslations('adminSecurity.account.emailVerify');
  const [state, formAction] = useActionState(action, SECURITY_IDLE);
  useSuccessToast(state);
  if (verified) return <p className="text-sm text-muted-foreground">{t('verified')}</p>;
  return (
    <ActionForm action={formAction} className="max-w-md space-y-4">
      <ErrorAlert state={state} />
      <p className="text-sm">{t('unverified', { email })}</p>
      <SubmitButton>{t('send')}</SubmitButton>
    </ActionForm>
  );
}

/** Ends the own sessions on all other devices; this browser stays signed in. */
export function SessionsForm({
  action,
  activeSessions,
}: {
  action: Action;
  activeSessions: number;
}) {
  const t = useTranslations('adminSecurity.account.sessions');
  const [state, formAction] = useActionState(action, SECURITY_IDLE);
  useSuccessToast(state);
  return (
    <ActionForm action={formAction} className="max-w-md space-y-4">
      <ErrorAlert state={state} />
      <p className="text-sm" data-testid="account-active-sessions">
        {t('active', { count: activeSessions })}
      </p>
      <SubmitButton variant="outline" data-testid="account-sign-out-others">
        {t('signOutOthers')}
      </SubmitButton>
    </ActionForm>
  );
}

export function PasswordForm({ action, minLength }: { action: Action; minLength: number }) {
  const t = useTranslations('adminSecurity.account.password');
  const [state, formAction] = useActionState(action, SECURITY_IDLE);
  useSuccessToast(state);
  // The form keeps its input on errors; after a successful change the secrets are cleared.
  return (
    <ActionForm
      resetOnSuccess={state.status === 'success' ? { status: 'success', at: state.at } : undefined}
      action={formAction}
      className="max-w-md space-y-4"
      autoComplete="off"
    >
      <ErrorAlert state={state} />
      <Field label={t('current')} htmlFor="currentPassword">
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <Field label={t('new')} htmlFor="newPassword" hint={t('hint', { min: minLength })}>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
        />
      </Field>
      <Field label={t('confirm')} htmlFor="confirmPassword">
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
        />
      </Field>
      <p className="text-xs text-muted-foreground">{t('sessionsNote')}</p>
      <SubmitButton>{t('save')}</SubmitButton>
    </ActionForm>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const t = useTranslations('adminSecurity.twoFactor');
  return (
    <div className="space-y-3 rounded-md border bg-muted/40 p-4">
      <p className="text-sm font-medium">{t('recoveryTitle')}</p>
      <p className="text-xs text-muted-foreground">{t('recoveryHint')}</p>
      <ul className="grid grid-cols-1 gap-1 font-mono text-sm sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard
            .writeText(codes.join('\n'))
            .then(() => toast.success(t('copied')));
        }}
      >
        {t('copy')}
      </Button>
    </div>
  );
}

function PasswordAndCode({ idPrefix }: { idPrefix: string }) {
  const t = useTranslations('adminSecurity.twoFactor');
  return (
    <>
      <Field label={t('password')} htmlFor={`${idPrefix}-password`}>
        <Input
          id={`${idPrefix}-password`}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <Field label={t('code')} htmlFor={`${idPrefix}-code`} hint={t('codeHintAny')}>
        <Input
          id={`${idPrefix}-code`}
          name="code"
          autoComplete="one-time-code"
          required
          maxLength={64}
        />
      </Field>
    </>
  );
}

export function TwoFactorPanel({
  enabled,
  required,
  recoveryCodesLeft,
  startSetup,
  confirmAction,
  disableAction,
  regenerateAction,
}: {
  enabled: boolean;
  /** All admins must use two-factor authentication (cannot be disabled). */
  required: boolean;
  recoveryCodesLeft: number;
  startSetup: () => Promise<SecurityState>;
  confirmAction: Action;
  disableAction: Action;
  regenerateAction: Action;
}) {
  const t = useTranslations('adminSecurity.twoFactor');
  const router = useRouter();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [startError, setStartError] = useState<SecurityState>(SECURITY_IDLE);
  const [starting, startTransition] = useTransition();
  const [confirmState, confirm] = useActionState(confirmAction, SECURITY_IDLE);
  const [disableState, disable] = useActionState(disableAction, SECURITY_IDLE);
  const [regenState, regenerate] = useActionState(regenerateAction, SECURITY_IDLE);
  useSuccessToast(confirmState);
  useSuccessToast(disableState);
  useSuccessToast(regenState);

  const confirmedCodes = confirmState.status === 'success' ? confirmState.recoveryCodes : undefined;
  if (confirmedCodes) {
    return (
      <div className="max-w-md space-y-4">
        <Alert>
          <AlertDescription>{t('enabledNow')}</AlertDescription>
        </Alert>
        <RecoveryCodes codes={confirmedCodes} />
        <Button type="button" onClick={() => router.refresh()}>
          {t('done')}
        </Button>
      </div>
    );
  }

  if (!enabled) {
    if (!setup) {
      return (
        <div className="max-w-md space-y-4">
          <p className="text-sm text-muted-foreground">{t('offIntro')}</p>
          <ErrorAlert state={startError} />
          <Button
            type="button"
            disabled={starting}
            onClick={() =>
              startTransition(async () => {
                const result = await startSetup();
                if (result.status === 'success' && result.setup) setSetup(result.setup);
                else setStartError(result);
              })
            }
          >
            {t('start')}
          </Button>
        </div>
      );
    }
    return (
      <div className="max-w-md space-y-4">
        <p className="text-sm text-muted-foreground">{t('scanIntro')}</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={setup.qrDataUrl}
          alt={t('qrAlt')}
          width={200}
          height={200}
          className="rounded-md border bg-paper"
        />
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('manualKey')}</p>
          <code className="block font-mono text-sm break-all select-all">{setup.secret}</code>
        </div>
        <ActionForm action={confirm} className="space-y-4">
          <ErrorAlert state={confirmState} />
          <Field label={t('password')} htmlFor="totp-password">
            <Input
              id="totp-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label={t('confirmCode')} htmlFor="totp-confirm" hint={t('confirmHint')}>
            <Input
              id="totp-confirm"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              required
            />
          </Field>
          <SubmitButton pendingLabel={t('verifying')}>{t('enable')}</SubmitButton>
        </ActionForm>
      </div>
    );
  }

  const regenCodes = regenState.status === 'success' ? regenState.recoveryCodes : undefined;
  return (
    <div className="max-w-md space-y-8">
      <Alert>
        <AlertDescription>
          {t('onStatus', { count: recoveryCodesLeft })}
          {required ? ` ${t('requiredNote')}` : ''}
        </AlertDescription>
      </Alert>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t('regenerateTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('regenerateHint')}</p>
        {regenCodes && <RecoveryCodes codes={regenCodes} />}
        <ActionForm action={regenerate} className="space-y-4">
          <ErrorAlert state={regenState} />
          <PasswordAndCode idPrefix="regen" />
          <SubmitButton variant="outline" pendingLabel={t('verifying')}>
            {t('regenerate')}
          </SubmitButton>
        </ActionForm>
      </div>

      {!required && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('disableTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('disableHint')}</p>
          <ActionForm action={disable} className="space-y-4">
            <ErrorAlert state={disableState} />
            <PasswordAndCode idPrefix="disable" />
            <SubmitButton variant="destructive" pendingLabel={t('verifying')}>
              {t('disable')}
            </SubmitButton>
          </ActionForm>
        </div>
      )}
    </div>
  );
}

/** Own choice of warning e-mails (alert types the roles allow). */
export function AlertPreferencesForm({
  saveAction,
  resetAction,
  selectable,
  selected,
  isDefault,
  globallyEnabled,
}: {
  saveAction: Action;
  resetAction: Action;
  selectable: readonly AdminAlertType[];
  selected: readonly AdminAlertType[];
  isDefault: boolean;
  globallyEnabled: boolean;
}) {
  const t = useTranslations('system.alerts');
  const [saveState, saveForm] = useActionState(saveAction, SECURITY_IDLE);
  const [resetState, resetForm] = useActionState(resetAction, SECURITY_IDLE);
  const router = useRouter();
  useSuccessToast(saveState);
  useSuccessToast(resetState);
  useEffect(() => {
    if (resetState.status === 'success') router.refresh();
  }, [resetState, router]);
  if (selectable.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('account.none')}</p>;
  }
  const groups = ADMIN_ALERT_GROUPS.map((group) => ({
    group,
    types: selectable.filter((type) => ALERT_TYPE_GROUP[type] === group),
  })).filter((g) => g.types.length > 0);
  return (
    <div className="space-y-4">
      {!globallyEnabled && (
        <Alert>
          <AlertDescription>{t('account.globalOff')}</AlertDescription>
        </Alert>
      )}
      <ActionForm
        action={saveForm}
        className="space-y-4"
        // Re-keyed after a reset so the checkboxes show the defaults again.
        key={`${isDefault}-${selected.join(',')}`}
      >
        <ErrorAlert state={saveState} />
        {groups.map(({ group, types }) => (
          <fieldset key={group} className="space-y-2">
            <legend className="text-sm font-semibold">{t(`groups.${group}`)}</legend>
            {types.map((type) => (
              <label key={type} className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="types"
                  value={type}
                  defaultChecked={selected.includes(type)}
                  className="mt-1 size-4"
                />
                <span>
                  <span className="font-medium">{t(`types.${type}.name`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`types.${type}.description`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
        <p className="text-xs text-muted-foreground">
          {isDefault ? t('account.defaultHint') : t('account.customHint')}
        </p>
        <SubmitButton>{t('account.save')}</SubmitButton>
      </ActionForm>
      {!isDefault && (
        <form action={resetForm}>
          <Button type="submit" variant="outline" size="sm">
            {t('account.reset')}
          </Button>
        </form>
      )}
    </div>
  );
}
