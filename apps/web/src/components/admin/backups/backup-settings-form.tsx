'use client';

import { BACKUP_FREQUENCIES } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BackupActionState } from '@/lib/backup-state';
import { ActionFeedback, ActionForm, Field, NativeSelect, SubmitButton } from '../form-controls';
import { SwitchRow, useSettingsForm, type Action } from '../settings-forms';

export interface BackupSettingsValues {
  scheduleEnabled: boolean;
  frequency: (typeof BACKUP_FREQUENCIES)[number];
  weekday: number;
  time: string;
  keepScheduled: number;
  manualMaxAgeDays: number;
  maxUploadMb: number;
  restoreRequiresTwoFactor: boolean;
  allowInsecureEndpoint: boolean;
  allowPrivateNetwork: boolean;
  externalEnabled: boolean;
  externalEndpoint?: string;
  externalBucket?: string;
  externalRegion: string;
  externalPrefix: string;
  externalForcePathStyle: boolean;
  alertEmail?: string;
}

export function BackupSettingsForm({
  action,
  testAction,
  initial,
  credentialsStored,
}: {
  action: Action;
  testAction: (state: BackupActionState, fd: FormData) => Promise<BackupActionState>;
  initial: BackupSettingsValues;
  credentialsStored: boolean;
}) {
  const t = useTranslations('backups.settings');
  const tf = useTranslations('backups.feedback');
  const tw = useTranslations('backups.weekdays');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [frequency, setFrequency] = useState(initial.frequency);
  const [testing, startTest] = useTransition();
  const [testResult, setTestResult] = useState<BackupActionState | null>(null);

  // The test uses the values currently typed into the form (nothing is saved).
  const runTest = (form: HTMLFormElement | null) => {
    if (!form) return;
    const fd = new FormData(form);
    startTest(async () => {
      const result = await testAction({ status: 'idle' }, fd);
      setTestResult(result);
      if (result.status === 'success') toast.success(tf('connectionOk'));
    });
  };

  return (
    <ActionForm action={formAction} className="space-y-6" autoComplete="off">
      <ActionFeedback state={state} />
      <div className="space-y-4">
        <SwitchRow
          name="restoreRequiresTwoFactor"
          defaultChecked={initial.restoreRequiresTwoFactor}
          label={t('restoreRequiresTwoFactor')}
        />
        <SwitchRow
          name="scheduleEnabled"
          defaultChecked={initial.scheduleEnabled}
          label={t('scheduleEnabled')}
          hint={t('scheduleHint')}
        />
        <div className="grid gap-4 md:grid-cols-3">
          <Field label={t('frequency')} htmlFor="frequency" error={err('frequency')}>
            <NativeSelect
              id="frequency"
              name="frequency"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as typeof frequency)}
            >
              {BACKUP_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {t(`frequencies.${f}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('weekday')} htmlFor="weekday" error={err('weekday')}>
            <NativeSelect
              id="weekday"
              name="weekday"
              defaultValue={initial.weekday}
              disabled={frequency !== 'WEEKLY'}
            >
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <option key={d} value={d}>
                  {tw(String(d) as '0')}
                </option>
              ))}
            </NativeSelect>
            {/* Disabled selects are not submitted: keep the stored weekday. */}
            {frequency !== 'WEEKLY' && (
              <input type="hidden" name="weekday" value={initial.weekday} />
            )}
          </Field>
          <Field label={t('time')} htmlFor="time" error={err('time')}>
            <Input id="time" name="time" type="time" defaultValue={initial.time} required />
          </Field>
          <Field
            label={t('keepScheduled')}
            htmlFor="keepScheduled"
            hint={t('keepScheduledHint')}
            error={err('keepScheduled')}
          >
            <Input
              id="keepScheduled"
              name="keepScheduled"
              type="number"
              min={1}
              max={365}
              defaultValue={initial.keepScheduled}
              required
            />
          </Field>
          <Field
            label={t('manualMaxAgeDays')}
            htmlFor="manualMaxAgeDays"
            hint={t('manualMaxAgeDaysHint')}
            error={err('manualMaxAgeDays')}
          >
            <Input
              id="manualMaxAgeDays"
              name="manualMaxAgeDays"
              type="number"
              min={0}
              max={3650}
              defaultValue={initial.manualMaxAgeDays}
              required
            />
          </Field>
          <Field label={t('maxUploadMb')} htmlFor="maxUploadMb" error={err('maxUploadMb')}>
            <Input
              id="maxUploadMb"
              name="maxUploadMb"
              type="number"
              min={1}
              defaultValue={initial.maxUploadMb}
              required
            />
          </Field>
          <Field
            label={t('alertEmail')}
            htmlFor="alertEmail"
            hint={t('alertEmailHint')}
            error={err('alertEmail')}
          >
            <Input
              id="alertEmail"
              name="alertEmail"
              type="email"
              defaultValue={initial.alertEmail ?? ''}
            />
          </Field>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <h3 className="text-sm font-medium">{t('external.title')}</h3>
        <SwitchRow
          name="externalEnabled"
          defaultChecked={initial.externalEnabled}
          label={t('external.enabled')}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label={t('external.endpoint')}
            htmlFor="externalEndpoint"
            hint={t('external.endpointHint')}
            error={err('externalEndpoint')}
          >
            <Input
              id="externalEndpoint"
              name="externalEndpoint"
              type="url"
              defaultValue={initial.externalEndpoint ?? ''}
              maxLength={500}
            />
          </Field>
          <Field
            label={t('external.bucket')}
            htmlFor="externalBucket"
            error={err('externalBucket')}
          >
            <Input
              id="externalBucket"
              name="externalBucket"
              defaultValue={initial.externalBucket ?? ''}
              maxLength={63}
            />
          </Field>
          <Field
            label={t('external.region')}
            htmlFor="externalRegion"
            error={err('externalRegion')}
          >
            <Input
              id="externalRegion"
              name="externalRegion"
              defaultValue={initial.externalRegion}
              maxLength={64}
              required
            />
          </Field>
          <Field
            label={t('external.prefix')}
            htmlFor="externalPrefix"
            hint={t('external.prefixHint')}
            error={err('externalPrefix')}
          >
            <Input
              id="externalPrefix"
              name="externalPrefix"
              defaultValue={initial.externalPrefix}
              maxLength={200}
            />
          </Field>
          <Field
            label={
              <span className="flex items-center gap-2">
                {t('external.accessKeyId')}
                <Badge variant={credentialsStored ? 'secondary' : 'outline'}>
                  {credentialsStored ? t('external.stored') : t('external.notStored')}
                </Badge>
              </span>
            }
            htmlFor="accessKeyId"
            hint={credentialsStored ? t('external.replaceHint') : t('external.enterHint')}
            error={err('accessKeyId')}
          >
            <Input id="accessKeyId" name="accessKeyId" autoComplete="off" maxLength={256} />
          </Field>
          <Field
            label={t('external.secretAccessKey')}
            htmlFor="secretAccessKey"
            error={err('secretAccessKey')}
          >
            <Input
              id="secretAccessKey"
              name="secretAccessKey"
              type="password"
              autoComplete="new-password"
              maxLength={1024}
            />
          </Field>
        </div>
        <SwitchRow
          name="allowInsecureEndpoint"
          defaultChecked={initial.allowInsecureEndpoint}
          label={t('allowInsecureEndpoint')}
        />
        <SwitchRow
          name="allowPrivateNetwork"
          defaultChecked={initial.allowPrivateNetwork}
          label={t('allowPrivateNetwork')}
        />
        <SwitchRow
          name="externalForcePathStyle"
          defaultChecked={initial.externalForcePathStyle}
          label={t('external.forcePathStyle')}
        />
        {credentialsStored && (
          <SwitchRow name="clearCredentials" defaultChecked={false} label={t('external.clear')} />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={testing}
            onClick={(e) => runTest(e.currentTarget.form)}
          >
            {testing ? t('external.testing') : t('external.test')}
          </Button>
          {testResult?.status === 'success' && (
            <span className="text-sm text-emerald-600">{tf('connectionOk')}</span>
          )}
        </div>
        {testResult?.status === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>
              {tf(testResult.code, { detail: testResult.detail ?? '' })}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <SubmitButton pendingLabel={tc('saving')}>{t('save')}</SubmitButton>
    </ActionForm>
  );
}
