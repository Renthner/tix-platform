'use client';

import { CircleAlert, CircleCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { ActionForm } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { lookupOrderAction, type OrderLookupState } from './actions';

export function OrderLookupForm() {
  const t = useTranslations('account.orderLookup');
  const [state, action, pending] = useActionState<OrderLookupState, FormData>(lookupOrderAction, {
    status: 'idle',
  });
  return (
    <ActionForm action={action} className="space-y-4" noValidate>
      {state.status === 'sent' && (
        <Alert role="status">
          <CircleCheck />
          <AlertDescription>{t('sent')}</AlertDescription>
        </Alert>
      )}
      {state.status === 'error' && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertDescription>{t(`errors.${state.error}`)}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="lookup-order-number">{t('orderNumber')}</Label>
        <Input
          id="lookup-order-number"
          name="orderNumber"
          required
          maxLength={64}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lookup-email">{t('email')}</Label>
        <Input
          id="lookup-email"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('submitting') : t('submit')}
      </Button>
    </ActionForm>
  );
}
