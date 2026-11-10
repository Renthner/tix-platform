'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useTransition } from 'react';
import { toast } from 'sonner';
import { ActionForm, Field, NativeSelect, SubmitButton } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  anonymizeCustomerAction,
  customerAccountAction,
  savePrivacySettingsAction,
  updateCustomerAction,
  type CustomerAccountOperation,
  type CustomerActionState,
} from '@/server/admin/customers';

const IDLE: CustomerActionState = { status: 'idle' };

/** Toast for an action result (success message or translated error code). */
function useFeedback(state: CustomerActionState) {
  const t = useTranslations('customers');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') toast.success(t(`messages.${state.message}` as never));
    else if (t.has(`errors.${state.code}` as never))
      toast.error(t(`errors.${state.code}` as never));
    else toast.error(t('errors.INTERNAL_ERROR'));
  }, [state, t]);
}

export interface ProfileValues {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  phone: string;
  locale: string;
  street: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
}

/** Editable profile; inputs stay after errors (uncontrolled inputs + ActionForm). */
export function CustomerProfileForm({
  customerId,
  initial,
  locales,
  disabled,
}: {
  customerId: string;
  initial: ProfileValues;
  locales: { value: string; label: string }[];
  disabled: boolean;
}) {
  const t = useTranslations('customers.profile');
  const [state, action] = useActionState(updateCustomerAction.bind(null, customerId), IDLE);
  useFeedback(state);
  const bad = (name: string) =>
    state.status === 'error' && state.fields?.includes(name) ? true : undefined;
  const addressBad =
    bad('address') ?? bad('street') ?? bad('postalCode') ?? bad('city') ?? bad('country');
  return (
    <ActionForm action={action} className="space-y-4">
      <fieldset disabled={disabled} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('firstName')} htmlFor="firstName">
            <Input
              id="firstName"
              name="firstName"
              defaultValue={initial.firstName}
              maxLength={100}
              required
              aria-invalid={bad('firstName')}
            />
          </Field>
          <Field label={t('lastName')} htmlFor="lastName">
            <Input
              id="lastName"
              name="lastName"
              defaultValue={initial.lastName}
              maxLength={100}
              required
              aria-invalid={bad('lastName')}
            />
          </Field>
          <Field label={t('email')} htmlFor="email" hint={t('emailHint')}>
            <Input
              id="email"
              name="email"
              type="email"
              defaultValue={initial.email}
              maxLength={254}
              required
              aria-invalid={bad('email')}
            />
          </Field>
          <Field label={t('company')} htmlFor="company">
            <Input id="company" name="company" defaultValue={initial.company} maxLength={200} />
          </Field>
          <Field label={t('phone')} htmlFor="phone">
            <Input id="phone" name="phone" defaultValue={initial.phone} maxLength={50} />
          </Field>
          <Field label={t('locale')} htmlFor="locale">
            <NativeSelect id="locale" name="locale" defaultValue={initial.locale}>
              <option value="">–</option>
              {locales.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="space-y-3">
          <div className="text-sm font-medium">{t('address')}</div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('street')} htmlFor="street" className="md:col-span-2">
              <Input
                id="street"
                name="street"
                defaultValue={initial.street}
                maxLength={200}
                aria-invalid={addressBad}
              />
            </Field>
            <Field label={t('addressLine2')} htmlFor="addressLine2" className="md:col-span-2">
              <Input
                id="addressLine2"
                name="addressLine2"
                defaultValue={initial.addressLine2}
                maxLength={200}
              />
            </Field>
            <Field label={t('postalCode')} htmlFor="postalCode">
              <Input
                id="postalCode"
                name="postalCode"
                defaultValue={initial.postalCode}
                maxLength={20}
                aria-invalid={addressBad}
              />
            </Field>
            <Field label={t('city')} htmlFor="city">
              <Input
                id="city"
                name="city"
                defaultValue={initial.city}
                maxLength={120}
                aria-invalid={addressBad}
              />
            </Field>
            <Field label={t('country')} htmlFor="country" hint={t('countryHint')}>
              <Input
                id="country"
                name="country"
                defaultValue={initial.country}
                maxLength={2}
                className="uppercase"
                aria-invalid={addressBad}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('addressHint')}</p>
        </div>
        {state.status === 'error' && state.code === 'VALIDATION' && (
          <p className="text-sm text-destructive" role="alert">
            {t('invalid')}
          </p>
        )}
        <SubmitButton>{t('save')}</SubmitButton>
      </fieldset>
    </ActionForm>
  );
}

/** One-click account operations. */
export function AccountActions({
  customerId,
  hasAccount,
  verified,
  locked,
  anonymized,
}: {
  customerId: string;
  hasAccount: boolean;
  verified: boolean;
  locked: boolean;
  anonymized: boolean;
}) {
  const t = useTranslations('customers.account');
  const [pending, start] = useTransition();
  const [state, setState] = useActionState(
    async (_prev: CustomerActionState, op: CustomerAccountOperation) =>
      customerAccountAction(customerId, op),
    IDLE,
  );
  useFeedback(state);
  const run = (op: CustomerAccountOperation) => () => start(() => setState(op));
  if (anonymized) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {hasAccount && !verified && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={run('resendVerification')}
        >
          {t('resendVerification')}
        </Button>
      )}
      {hasAccount && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={run('sendPasswordReset')}
        >
          {t('sendPasswordReset')}
        </Button>
      )}
      {locked && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={run('unlock')}
        >
          {t('unlock')}
        </Button>
      )}
      {hasAccount && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (window.confirm(t('removeLoginConfirm'))) run('removeLogin')();
          }}
        >
          {t('removeLogin')}
        </Button>
      )}
    </div>
  );
}

/** Art. 17 form: password re-confirmation + typed e-mail address. */
export function AnonymizeForm({ customerId, email }: { customerId: string; email: string }) {
  const t = useTranslations('customers.anonymize');
  const [state, action] = useActionState(anonymizeCustomerAction.bind(null, customerId), IDLE);
  useFeedback(state);
  return (
    <ActionForm action={action} className="space-y-3">
      <Field label={t('confirmLabel', { email })} htmlFor="confirm">
        <Input id="confirm" name="confirm" autoComplete="off" required placeholder={email} />
      </Field>
      <Field label={t('password')} htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <SubmitButton variant="destructive" pendingLabel={t('submitting')}>
        {t('submit')}
      </SubmitButton>
    </ActionForm>
  );
}

export function PrivacySettingsForm({
  initial,
}: {
  initial: {
    emailRetentionDays: number;
    invoiceRetentionYears: number;
    webhookRetentionDays: number;
  };
}) {
  const t = useTranslations('customers.settings');
  const [state, action] = useActionState(savePrivacySettingsAction, IDLE);
  useFeedback(state);
  return (
    <ActionForm action={action} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label={t('emailRetentionDays')}
          htmlFor="emailRetentionDays"
          hint={t('emailRetentionDaysHint')}
        >
          <Input
            id="emailRetentionDays"
            name="emailRetentionDays"
            type="number"
            min={0}
            max={3650}
            defaultValue={initial.emailRetentionDays}
            required
          />
        </Field>
        <Field
          label={t('invoiceRetentionYears')}
          htmlFor="invoiceRetentionYears"
          hint={t('invoiceRetentionYearsHint')}
        >
          <Input
            id="invoiceRetentionYears"
            name="invoiceRetentionYears"
            type="number"
            min={1}
            max={30}
            defaultValue={initial.invoiceRetentionYears}
            required
          />
        </Field>
        <Field
          label={t('webhookRetentionDays')}
          htmlFor="webhookRetentionDays"
          hint={t('webhookRetentionDaysHint')}
        >
          <Input
            id="webhookRetentionDays"
            name="webhookRetentionDays"
            type="number"
            min={0}
            max={3650}
            defaultValue={initial.webhookRetentionDays}
            required
          />
        </Field>
      </div>
      <SubmitButton>{t('save')}</SubmitButton>
    </ActionForm>
  );
}
