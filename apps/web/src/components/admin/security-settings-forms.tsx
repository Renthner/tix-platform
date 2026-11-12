'use client';

import {
  APP_UPDATE_CHANNELS,
  APP_UPDATE_SOURCES,
  APP_VERSION,
  SCAN_RESULT_COLOR_KEYS,
  defaultSetting,
  readableTextColor,
  type AppUpdateChannel,
  type AppUpdateSource,
  type ScanResultColors,
} from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionFeedback, ActionForm, Field, NativeSelect, SubmitButton } from './form-controls';
import { ColorField, SwitchRow, useSettingsForm, type Action } from './settings-forms';

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
  appUpdateSource: AppUpdateSource;
  githubRepository: string;
  defaultUpdateChannel: AppUpdateChannel;
  allowChannelOverride: boolean;
  resultColors: ScanResultColors;
}

function AppUpdatesCard({
  initial,
  err,
}: {
  initial: ScannerValues;
  err: ReturnType<typeof useSettingsForm>['err'];
}) {
  const t = useTranslations('adminSecurity.settings.scanner.appUpdates');
  const [source, setSource] = useState<AppUpdateSource>(initial.appUpdateSource);
  // The GitHub fields stay enabled (a disabled field is not submitted and would reset to its default).
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="space-y-2" role="radiogroup" aria-label={t('source')}>
        {APP_UPDATE_SOURCES.map((value) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="appUpdateSource"
              value={value}
              checked={source === value}
              onChange={() => setSource(value)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{t(`sources.${value}`)}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`sources.${value}Hint`)}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label={t('githubRepository')}
          htmlFor="githubRepository"
          error={err('githubRepository')}
          hint={t('githubRepositoryHint')}
        >
          <Input
            id="githubRepository"
            name="githubRepository"
            defaultValue={initial.githubRepository}
            placeholder="owner/repo"
            maxLength={140}
          />
        </Field>
      </div>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('legacyChannelTitle')}</summary>
        <div className="mt-3 space-y-3">
          <Field
            label={t('defaultUpdateChannel')}
            htmlFor="defaultUpdateChannel"
            error={err('defaultUpdateChannel')}
            hint={t('defaultUpdateChannelHint')}
          >
            <NativeSelect
              id="defaultUpdateChannel"
              name="defaultUpdateChannel"
              defaultValue={initial.defaultUpdateChannel}
            >
              {APP_UPDATE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`channels.${c}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <SwitchRow
            name="allowChannelOverride"
            defaultChecked={initial.allowChannelOverride}
            label={t('allowChannelOverride')}
            hint={t('allowChannelOverrideHint')}
          />
        </div>
      </details>
      <p className="text-xs text-muted-foreground">{t('versionRule', { version: APP_VERSION })}</p>
    </section>
  );
}

function ResultColorsCard({
  initial,
  err,
}: {
  initial: ScanResultColors;
  err: ReturnType<typeof useSettingsForm>['err'];
}) {
  const t = useTranslations('adminSecurity.settings.scanner.resultColors');
  const [colors, setColors] = useState<ScanResultColors>(initial);
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {SCAN_RESULT_COLOR_KEYS.map((key) => (
          <ColorField
            key={key}
            name={`resultColors.${key}`}
            label={t(`labels.${key}`)}
            value={colors[key]}
            onChange={(value) => setColors((c) => ({ ...c, [key]: value }))}
            error={err(`resultColors.${key}`)}
          />
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3" aria-label={t('preview')}>
        {SCAN_RESULT_COLOR_KEYS.map((key) => {
          const valid = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(colors[key]);
          const bg = valid ? colors[key] : '#FFFFFF';
          return (
            <div
              key={key}
              className="rounded-md border px-3 py-3 text-center text-sm font-semibold"
              style={{ backgroundColor: bg, color: readableTextColor(bg) }}
            >
              {t(`labels.${key}`)}
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setColors(defaultSetting('scanner').resultColors)}
      >
        {t('reset')}
      </Button>
    </section>
  );
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
      <AppUpdatesCard initial={initial} err={err} />
      <ResultColorsCard initial={initial.resultColors} err={err} />
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
