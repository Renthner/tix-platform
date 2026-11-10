'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { cancelTwoFactorAction, loginAction, twoFactorAction, type LoginState } from './actions';

export function LoginForm({
  initialStep,
  notice,
}: {
  initialStep: LoginState['step'];
  notice?: 'reset' | 'invited' | null;
}) {
  const t = useTranslations('admin.login');
  const ts = useTranslations('adminSecurity.login');
  const [state, setState] = useState<LoginState>({ step: initialStep, error: null });
  const [pending, setPending] = useState(false);

  const submit = async (formData: FormData) => {
    setPending(true);
    try {
      setState(
        await (state.step === 'code'
          ? twoFactorAction(state, formData)
          : loginAction(state, formData)),
      );
    } finally {
      setPending(false);
    }
  };

  if (state.step === 'code') {
    return (
      <ActionForm action={submit} className="space-y-4">
        <p className="text-sm text-muted-foreground">{ts('codeIntro')}</p>
        {state.error && (
          <Alert variant="destructive">
            <AlertDescription>{ts(`errors.${state.error}`)}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="code">{ts('code')}</Label>
          <Input
            id="code"
            name="code"
            autoComplete="one-time-code"
            inputMode="text"
            autoFocus
            required
          />
          <p className="text-xs text-muted-foreground">{ts('codeHint')}</p>
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? t('submitting') : ts('verify')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={pending}
          onClick={async () => setState(await cancelTwoFactorAction())}
        >
          {ts('back')}
        </Button>
      </ActionForm>
    );
  }

  return (
    <ActionForm action={submit} className="space-y-4">
      {notice && (
        <Alert>
          <AlertDescription>{ts(`notice.${notice}`)}</AlertDescription>
        </Alert>
      )}
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>
            {state.error === 'INVALID_CODE' ? t('errors.INVALID') : ts(`errors.${state.error}`)}
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="email">{t('email')}</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t('password')}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('submitting') : t('submit')}
      </Button>
      <p className="text-center text-sm">
        <Link href="/admin/forgot-password" className="text-muted-foreground underline">
          {ts('forgot')}
        </Link>
      </p>
    </ActionForm>
  );
}
