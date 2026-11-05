'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { ActionForm } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { loginAction, type LoginState } from './actions';

export function LoginForm() {
  const t = useTranslations('admin.login');
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {
    error: null,
  });
  return (
    <ActionForm action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{t(`errors.${state.error}`)}</AlertDescription>
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
    </ActionForm>
  );
}
