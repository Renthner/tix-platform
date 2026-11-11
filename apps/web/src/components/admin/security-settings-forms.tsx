'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { ActionFeedback, ActionForm, Field, SubmitButton } from './form-controls';
import { SwitchRow, useSettingsForm, type Action } from './settings-forms';

/* Settings tabs "Security" (admin sessions, lockout, passwords, two-factor, links) and
 * "Scanner" (behaviour of the Android check-in app). */

function NumberField({
  name,
  label,
  hint,
  defaultValue,
  min,
  max,
  error,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue: number;
  min: number;
  max: number;
  error?: Parameters<typeof Field>[0]['error'];
}) {
  return (
    <Field label={label} htmlFor={name} error={error} hint={hint}>
      <Input
        id={name}
        name={name}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        defaultValue={defaultValue}
        required
      />
    </Field>
  );
}

export interface SecurityValues {
  adminSessionTtlHours: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  minPasswordLength: number;
  requireTwoFactor: boolean;
  inviteTtlHours: number;
  passwordResetTtlMinutes: number;
}

export function SecuritySettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: SecurityValues;
}) {
  const t = useTranslations('adminSecurity.settings.security');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <SwitchRow
        name="requireTwoFactor"
        defaultChecked={initial.requireTwoFactor}
        label={t('requireTwoFactor')}
        hint={t('requireTwoFactorHint')}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <NumberField
          name="adminSessionTtlHours"
          label={t('adminSessionTtlHours')}
          hint={t('adminSessionTtlHoursHint')}
          defaultValue={initial.adminSessionTtlHours}
          min={1}
          max={720}
          error={err('adminSessionTtlHours')}
        />
        <NumberField
          name="minPasswordLength"
          label={t('minPasswordLength')}
          defaultValue={initial.minPasswordLength}
          min={8}
          max={128}
          error={err('minPasswordLength')}
        />
        <NumberField
          name="maxFailedLogins"
          label={t('maxFailedLogins')}
          defaultValue={initial.maxFailedLogins}
          min={3}
          max={50}
          error={err('maxFailedLogins')}
        />
        <NumberField
          name="lockoutMinutes"
          label={t('lockoutMinutes')}
          defaultValue={initial.lockoutMinutes}
          min={1}
          max={1440}
          error={err('lockoutMinutes')}
        />
        <NumberField
          name="inviteTtlHours"
          label={t('inviteTtlHours')}
          defaultValue={initial.inviteTtlHours}
          min={1}
          max={720}
          error={err('inviteTtlHours')}
        />
        <NumberField
          name="passwordResetTtlMinutes"
          label={t('passwordResetTtlMinutes')}
          defaultValue={initial.passwordResetTtlMinutes}
          min={5}
          max={1440}
          error={err('passwordResetTtlMinutes')}
        />
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

export interface ScannerValues {
  allowCheckOut: boolean;
  offlineModeAllowed: boolean;
  lanSyncEnabled: boolean;
  syncIntervalSeconds: number;
  pairingCodeTtlMinutes: number;
  serverUrl?: string;
}

export function ScannerSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: ScannerValues;
}) {
  const t = useTranslations('adminSecurity.settings.scanner');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <div className="space-y-3">
        <SwitchRow
          name="allowCheckOut"
          defaultChecked={initial.allowCheckOut}
          label={t('allowCheckOut')}
          hint={t('allowCheckOutHint')}
        />
        <SwitchRow
          name="offlineModeAllowed"
          defaultChecked={initial.offlineModeAllowed}
          label={t('offlineModeAllowed')}
          hint={t('offlineModeAllowedHint')}
        />
        <SwitchRow
          name="lanSyncEnabled"
          defaultChecked={initial.lanSyncEnabled}
          label={t('lanSyncEnabled')}
          hint={t('lanSyncEnabledHint')}
        />
      </div>
      <Field
        label={t('serverUrl')}
        htmlFor="serverUrl"
        error={err('serverUrl')}
        hint={t('serverUrlHint')}
      >
        <Input
          id="serverUrl"
          name="serverUrl"
          type="url"
          inputMode="url"
          placeholder="http://192.168.1.20:8080"
          defaultValue={initial.serverUrl ?? ''}
        />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <NumberField
          name="syncIntervalSeconds"
          label={t('syncIntervalSeconds')}
          hint={t('syncIntervalSecondsHint')}
          defaultValue={initial.syncIntervalSeconds}
          min={5}
          max={3600}
          error={err('syncIntervalSeconds')}
        />
        <NumberField
          name="pairingCodeTtlMinutes"
          label={t('pairingCodeTtlMinutes')}
          hint={t('pairingCodeTtlMinutesHint')}
          defaultValue={initial.pairingCodeTtlMinutes}
          min={1}
          max={1440}
          error={err('pairingCodeTtlMinutes')}
        />
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}
