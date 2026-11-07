'use client';

import type { PostalAddress } from '@tix/shared';
import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { ActionForm } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ACCOUNT_IDLE, type AccountFormState } from '@/lib/account-form';
import {
  changePasswordAction,
  resendVerificationAction,
  signOutAction,
  updateProfileAction,
} from '../actions';
import { FormStatus, TextField } from './form-bits';

/** Re-renders the server page once after each successful save (fresh session data). */
function useRefreshOnSuccess(state: AccountFormState) {
  const router = useRouter();
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status !== 'success' || state.at === last.current) return;
    last.current = state.at;
    router.refresh();
  }, [state, router]);
}

export function ProfileForm({
  email,
  firstName,
  lastName,
  phone,
  address,
  defaultCountry,
}: {
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  address: PostalAddress | null;
  defaultCountry: string;
}) {
  const t = useTranslations('account');
  const [state, action, pending] = useActionState<AccountFormState, FormData>(
    updateProfileAction,
    ACCOUNT_IDLE,
  );
  useRefreshOnSuccess(state);
  return (
    <ActionForm action={action} className="space-y-4" noValidate>
      <FormStatus state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="firstName"
          label={t('fields.firstName')}
          autoComplete="given-name"
          defaultValue={firstName}
          maxLength={100}
          state={state}
        />
        <TextField
          name="lastName"
          label={t('fields.lastName')}
          autoComplete="family-name"
          defaultValue={lastName}
          maxLength={100}
          state={state}
        />
        <TextField
          name="email"
          type="email"
          label={t('fields.email')}
          value={email}
          readOnly
          disabled
          hint={t('profile.emailHint')}
          state={state}
        />
        <TextField
          name="phone"
          type="tel"
          label={t('profile.phone')}
          autoComplete="tel"
          defaultValue={phone ?? ''}
          maxLength={50}
          state={state}
        />
      </div>
      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">{t('profile.addressTitle')}</legend>
        <TextField
          name="street"
          label={t('profile.street')}
          autoComplete="address-line1"
          defaultValue={address?.street ?? ''}
          maxLength={200}
          state={state}
        />
        <TextField
          name="addressLine2"
          label={t('profile.addressLine2')}
          autoComplete="address-line2"
          defaultValue={address?.addressLine2 ?? ''}
          maxLength={200}
          state={state}
        />
        <div className="grid gap-4 sm:grid-cols-[1fr_2fr_1fr]">
          <TextField
            name="postalCode"
            label={t('profile.postalCode')}
            autoComplete="postal-code"
            defaultValue={address?.postalCode ?? ''}
            maxLength={20}
            state={state}
          />
          <TextField
            name="city"
            label={t('profile.city')}
            autoComplete="address-level2"
            defaultValue={address?.city ?? ''}
            maxLength={120}
            state={state}
          />
          <TextField
            name="country"
            label={t('profile.country')}
            autoComplete="country"
            defaultValue={address?.country ?? defaultCountry}
            maxLength={2}
            inputClassName="uppercase"
            hint={t('profile.countryHint')}
            state={state}
          />
        </div>
      </fieldset>
      <Button type="submit" disabled={pending}>
        {pending ? t('fields.submitting') : t('profile.submit')}
      </Button>
    </ActionForm>
  );
}

export function PasswordForm({
  hasPassword,
  minLength,
}: {
  hasPassword: boolean;
  minLength: number;
}) {
  const t = useTranslations('account');
  const [state, action, pending] = useActionState<AccountFormState, FormData>(
    changePasswordAction,
    ACCOUNT_IDLE,
  );
  useRefreshOnSuccess(state);
  return (
    <ActionForm
      action={action}
      resetOnSuccess={toResetState(state)}
      className="space-y-4"
      noValidate
    >
      <FormStatus state={state} />
      {hasPassword && (
        <TextField
          name="currentPassword"
          type="password"
          label={t('password.current')}
          autoComplete="current-password"
          state={state}
        />
      )}
      <TextField
        name="newPassword"
        type="password"
        label={t('fields.newPassword')}
        autoComplete="new-password"
        hint={t('fields.passwordHint', { min: minLength })}
        state={state}
      />
      <TextField
        name="newPasswordConfirm"
        type="password"
        label={t('fields.passwordConfirm')}
        autoComplete="new-password"
        state={state}
      />
      <Button type="submit" disabled={pending}>
        {pending
          ? t('fields.submitting')
          : hasPassword
            ? t('password.submit')
            : t('password.submitSet')}
      </Button>
    </ActionForm>
  );
}

/** `ActionForm` clears itself on an admin-style success state – passwords are not kept. */
function toResetState(state: AccountFormState) {
  return state.status === 'success'
    ? { status: 'success' as const, at: state.at }
    : { status: 'idle' as const };
}

export function ResendVerificationForm({ next }: { next?: string }) {
  const t = useTranslations('account');
  const [state, action, pending] = useActionState<AccountFormState, FormData>(
    resendVerificationAction,
    ACCOUNT_IDLE,
  );
  useRefreshOnSuccess(
    state.status === 'success' && state.message === 'alreadyVerified' ? state : ACCOUNT_IDLE,
  );
  return (
    <ActionForm action={action} className="space-y-3">
      {next && <input type="hidden" name="next" value={next} />}
      <FormStatus state={state} />
      {state.status !== 'success' && (
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? t('fields.submitting') : t('overview.resend')}
        </Button>
      )}
    </ActionForm>
  );
}

function SignOutSubmit() {
  const t = useTranslations('account');
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      <LogOut />
      {t('overview.signOut')}
    </Button>
  );
}

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <SignOutSubmit />
    </form>
  );
}
