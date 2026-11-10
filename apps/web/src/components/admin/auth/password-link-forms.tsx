'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { ActionForm } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { SECURITY_IDLE, type SecurityState } from '@/lib/security-state';

type Action = (state: SecurityState, fd: FormData) => Promise<SecurityState>;

export function ErrorAlert({ state }: { state: SecurityState }) {
  const t = useTranslations('adminSecurity.errors');
  if (state.status !== 'error') return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{t(state.code, { min: state.min ?? 0 })}</AlertDescription>
    </Alert>
  );
}

export function ForgotPasswordForm({ action }: { action: Action }) {
  const t = useTranslations('adminSecurity.forgot');
  const [state, formAction, pending] = useActionState(action, SECURITY_IDLE);
  if (state.status === 'success') {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>{t('sent')}</AlertDescription>
        </Alert>
        <Link href="/admin/login" className="text-sm underline">
          {t('backToLogin')}
        </Link>
      </div>
    );
  }
  return (
    <ActionForm action={formAction} className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <ErrorAlert state={state} />
      <div className="space-y-2">
        <Label htmlFor="email">{t('email')}</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {t('submit')}
      </Button>
      <p className="text-center text-sm">
        <Link href="/admin/login" className="text-muted-foreground underline">
          {t('backToLogin')}
        </Link>
      </p>
    </ActionForm>
  );
}

export function SetPasswordForm({
  action,
  mode,
  minLength,
}: {
  action: Action;
  mode: 'invite' | 'reset';
  minLength: number;
}) {
  const t = useTranslations('adminSecurity.setPassword');
  const [state, formAction, pending] = useActionState(action, SECURITY_IDLE);
  return (
    <ActionForm action={formAction} className="space-y-4">
      <p className="text-sm text-muted-foreground">{t(`${mode}Intro`)}</p>
      <ErrorAlert state={state} />
      <div className="space-y-2">
        <Label htmlFor="password">{t('password')}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
        />
        <p className="text-xs text-muted-foreground">{t('hint', { min: minLength })}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">{t('confirm')}</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {t(`${mode}Submit`)}
      </Button>
    </ActionForm>
  );
}
