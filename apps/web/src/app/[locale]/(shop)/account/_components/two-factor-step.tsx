'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  cancelTwoFactorAction,
  twoFactorAction,
  type LoginState,
} from '@/app/[locale]/admin/login/actions';
import { ActionForm } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Second step of the shop sign-in for admin accounts with two-factor authentication: the same
 * server actions and pending-login cookie as the admin portal's sign-in; success redirects.
 */
export function TwoFactorStep({
  next,
  onBack,
}: {
  next: string | null;
  onBack: (expired?: boolean) => void;
}) {
  const t = useTranslations('account.login.twoFactor');
  const tFields = useTranslations('account.fields');
  const [error, setError] = useState<LoginState['error']>(null);
  const [pending, setPending] = useState(false);

  const submit = async (formData: FormData) => {
    setPending(true);
    try {
      const state = await twoFactorAction({ step: 'code', error: null }, formData);
      if (state.step === 'password') onBack(state.error === 'EXPIRED');
      else setError(state.error);
    } finally {
      setPending(false);
    }
  };

  return (
    <ActionForm action={submit} className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t(`errors.${error}`)}</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="form" value="shop" />
      <input type="hidden" name="next" value={next ?? '/'} />
      <div className="space-y-2">
        <Label htmlFor="account-code">{t('code')}</Label>
        <Input
          id="account-code"
          name="code"
          autoComplete="one-time-code"
          inputMode="text"
          autoFocus
          required
        />
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? tFields('submitting') : t('verify')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        disabled={pending}
        onClick={async () => {
          await cancelTwoFactorAction();
          onBack();
        }}
      >
        {t('back')}
      </Button>
    </ActionForm>
  );
}
