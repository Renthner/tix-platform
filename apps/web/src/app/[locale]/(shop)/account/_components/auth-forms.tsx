'use client';

import { Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { ActionForm } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ACCOUNT_IDLE, type AccountFormState } from '@/lib/account-form';
import {
  forgotPasswordAction,
  loginAction,
  loginLinkAction,
  registerAction,
  resetPasswordAction,
} from '../actions';
import { withNext } from './auth-card';
import { FormStatus, TextField } from './form-bits';

type Action = (prev: AccountFormState, fd: FormData) => Promise<AccountFormState>;

function useAccountAction(action: Action) {
  return useActionState<AccountFormState, FormData>(action, ACCOUNT_IDLE);
}

const NextField = ({ next }: { next: string | null }) =>
  next ? <input type="hidden" name="next" value={next} /> : null;

/** Password sign-in plus (optional) "e-mail me a sign-in link" with the same address. */
export function LoginForm({
  next,
  loginLinkEnabled,
}: {
  next: string | null;
  loginLinkEnabled: boolean;
}) {
  const t = useTranslations('account');
  const [state, action, pending] = useAccountAction(loginAction);
  return (
    <ActionForm action={action} className="space-y-4" noValidate>
      <FormStatus state={state} />
      <NextField next={next} />
      <TextField
        name="email"
        type="email"
        label={t('fields.email')}
        autoComplete="email"
        required
        state={state}
      />
      <TextField
        name="password"
        type="password"
        label={t('fields.password')}
        autoComplete="current-password"
        state={state}
      />
      <Button type="submit" name="intent" value="password" className="w-full" disabled={pending}>
        {pending ? t('fields.submitting') : t('login.submit')}
      </Button>
      {loginLinkEnabled && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t('login.or')}
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="submit"
            name="intent"
            value="link"
            variant="outline"
            className="w-full"
            disabled={pending}
          >
            <Mail />
            {t('login.linkSubmit')}
          </Button>
          <p className="text-center text-xs text-muted-foreground">{t('login.linkHint')}</p>
        </>
      )}
    </ActionForm>
  );
}

export function RegisterForm({ next, minLength }: { next: string | null; minLength: number }) {
  const t = useTranslations('account');
  const [state, action, pending] = useAccountAction(registerAction);
  if (state.status === 'success') {
    return (
      <div className="space-y-4">
        <FormStatus state={state} />
        {next && (
          // Signing in works before the address is confirmed – e.g. to finish a checkout.
          <Button asChild className="w-full">
            <Link href={withNext('/account/login', next)}>{t('register.continueToLogin')}</Link>
          </Button>
        )}
      </div>
    );
  }
  return (
    <ActionForm action={action} className="space-y-4" noValidate>
      <FormStatus state={state} />
      <NextField next={next} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="firstName"
          label={t('fields.firstName')}
          autoComplete="given-name"
          maxLength={100}
          required
          state={state}
        />
        <TextField
          name="lastName"
          label={t('fields.lastName')}
          autoComplete="family-name"
          maxLength={100}
          required
          state={state}
        />
      </div>
      <TextField
        name="email"
        type="email"
        label={t('fields.email')}
        autoComplete="email"
        maxLength={254}
        required
        state={state}
      />
      <TextField
        name="password"
        type="password"
        label={t('fields.password')}
        autoComplete="new-password"
        hint={t('fields.passwordHint', { min: minLength })}
        required
        state={state}
      />
      <TextField
        name="passwordConfirm"
        type="password"
        label={t('fields.passwordConfirm')}
        autoComplete="new-password"
        required
        state={state}
      />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('fields.submitting') : t('register.submit')}
      </Button>
    </ActionForm>
  );
}

export function ForgotPasswordForm({ next }: { next: string | null }) {
  const t = useTranslations('account');
  const [state, action, pending] = useAccountAction(forgotPasswordAction);
  return (
    <ActionForm action={action} className="space-y-4" noValidate>
      <FormStatus state={state} />
      <NextField next={next} />
      <TextField
        name="email"
        type="email"
        label={t('fields.email')}
        autoComplete="email"
        required
        state={state}
      />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('fields.submitting') : t('forgot.submit')}
      </Button>
    </ActionForm>
  );
}

export function ResetPasswordForm({
  token,
  next,
  minLength,
}: {
  token: string;
  next: string | null;
  minLength: number;
}) {
  const t = useTranslations('account');
  const [state, action, pending] = useAccountAction(resetPasswordAction);
  return (
    <ActionForm action={action} className="space-y-4" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="token" value={token} />
      <NextField next={next} />
      <TextField
        name="password"
        type="password"
        label={t('fields.newPassword')}
        autoComplete="new-password"
        hint={t('fields.passwordHint', { min: minLength })}
        required
        state={state}
      />
      <TextField
        name="passwordConfirm"
        type="password"
        label={t('fields.passwordConfirm')}
        autoComplete="new-password"
        required
        state={state}
      />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('fields.submitting') : t('reset.submit')}
      </Button>
    </ActionForm>
  );
}

/** Explicit button: mail scanners that open the link must not consume the token. */
export function LoginLinkForm({ token, next }: { token: string; next: string | null }) {
  const t = useTranslations('account');
  const [state, action, pending] = useAccountAction(loginLinkAction);
  return (
    <ActionForm action={action} className="space-y-4">
      <FormStatus state={state} />
      <input type="hidden" name="token" value={token} />
      <NextField next={next} />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('fields.submitting') : t('loginLink.submit')}
      </Button>
    </ActionForm>
  );
}
