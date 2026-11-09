'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { IDLE } from '@/lib/action-state';
import type { WalletCheckIssue } from '@tix/core';
import type { WalletCheckState } from '@/server/admin/wallet';
import { ActionFeedback, ActionForm, Field, SubmitButton } from './form-controls';
import { MediaPicker, type MediaPickerAsset } from './media-picker';
import { SwitchRow, useSettingsForm, type Action } from './settings-forms';

function StoredBadge({ stored }: { stored: boolean }) {
  const t = useTranslations('admin.settings.secret');
  return stored ? (
    <Badge variant="secondary">{t('stored')}</Badge>
  ) : (
    <Badge variant="outline">{t('notSet')}</Badge>
  );
}

/** Write-only text area for PEM / JSON secrets with a "load from file" helper. */
function SecretTextArea({
  name,
  label,
  stored,
  error,
  rows = 4,
  hint,
}: {
  name: string;
  label: string;
  stored: boolean;
  error?: Parameters<typeof Field>[0]['error'];
  rows?: number;
  hint?: string;
}) {
  const t = useTranslations('admin.wallet');
  const ts = useTranslations('admin.settings.secret');
  const ref = useRef<HTMLTextAreaElement>(null);
  const load = async (file: File | undefined) => {
    if (!file || !ref.current) return;
    ref.current.value = await file.text();
  };
  return (
    <Field
      label={
        <span className="flex items-center gap-2">
          {label} <StoredBadge stored={stored} />
        </span>
      }
      htmlFor={name}
      error={error}
      hint={hint ?? (stored ? ts('replaceHint') : ts('enterHint'))}
    >
      <Textarea
        ref={ref}
        id={name}
        name={name}
        rows={rows}
        className="font-mono text-xs"
        spellCheck={false}
        autoComplete="off"
        placeholder={stored ? ts('storedPlaceholder') : ''}
      />
      <label className="mt-1 inline-block cursor-pointer text-xs text-muted-foreground underline">
        {t('loadFile')}
        <input
          type="file"
          className="sr-only"
          accept=".pem,.crt,.cer,.key,.json,.txt"
          onChange={(e) => void load(e.target.files?.[0])}
        />
      </label>
    </Field>
  );
}

function TextInput({
  name,
  label,
  hint,
  defaultValue,
  error,
  maxLength,
  placeholder,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string | null;
  error?: Parameters<typeof Field>[0]['error'];
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <Field label={label} htmlFor={name} error={error} hint={hint}>
      <Input
        id={name}
        name={name}
        defaultValue={defaultValue ?? ''}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete="off"
      />
    </Field>
  );
}

// ─── Apple ──────────────────────────────────────────────────────────────────

export interface AppleWalletValues {
  enabled: boolean;
  passTypeIdentifier?: string;
  teamIdentifier?: string;
  organizationName?: string;
}

export function AppleWalletForm({
  action,
  initial,
  certificatesStored,
  passphraseStored,
}: {
  action: Action;
  initial: AppleWalletValues;
  certificatesStored: boolean;
  passphraseStored: boolean;
}) {
  const t = useTranslations('admin.wallet.apple');
  const ts = useTranslations('admin.settings.secret');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <SwitchRow
        name="enabled"
        defaultChecked={initial.enabled}
        label={t('enabled')}
        hint={t('enabledHint')}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <TextInput
          name="passTypeIdentifier"
          label={t('passTypeIdentifier')}
          hint={t('passTypeIdentifierHint')}
          defaultValue={initial.passTypeIdentifier}
          error={err('passTypeIdentifier')}
          maxLength={255}
          placeholder="pass.com.example.tickets"
        />
        <TextInput
          name="teamIdentifier"
          label={t('teamIdentifier')}
          hint={t('teamIdentifierHint')}
          defaultValue={initial.teamIdentifier}
          error={err('teamIdentifier')}
          maxLength={32}
          placeholder="ABCDE12345"
        />
        <TextInput
          name="organizationName"
          label={t('organizationName')}
          hint={t('organizationNameHint')}
          defaultValue={initial.organizationName}
          error={err('organizationName')}
          maxLength={255}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <SecretTextArea
          name="signerCertificatePem"
          label={t('signerCertificate')}
          stored={certificatesStored}
          error={err('signerCertificatePem')}
          hint={t('pemHint')}
        />
        <SecretTextArea
          name="signerKeyPem"
          label={t('signerKey')}
          stored={certificatesStored}
          error={err('signerKeyPem')}
          hint={t('keyHint')}
        />
        <SecretTextArea
          name="wwdrCertificatePem"
          label={t('wwdrCertificate')}
          stored={certificatesStored}
          error={err('wwdrCertificatePem')}
          hint={t('wwdrHint')}
        />
        <Field
          label={
            <span className="flex items-center gap-2">
              {t('signerKeyPassphrase')} <StoredBadge stored={passphraseStored} />
            </span>
          }
          htmlFor="signerKeyPassphrase"
          error={err('signerKeyPassphrase')}
          hint={t('passphraseHint')}
        >
          <Input
            id="signerKeyPassphrase"
            name="signerKeyPassphrase"
            type="password"
            autoComplete="new-password"
            placeholder={passphraseStored ? ts('storedPlaceholder') : ''}
          />
        </Field>
      </div>
      {certificatesStored && (
        <SwitchRow name="clearCertificates" defaultChecked={false} label={t('clearCertificates')} />
      )}
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Google ─────────────────────────────────────────────────────────────────

export interface GoogleWalletValues {
  enabled: boolean;
  issuerId?: string;
  classPrefix: string;
}

export function GoogleWalletForm({
  action,
  initial,
  credentialsStored,
}: {
  action: Action;
  initial: GoogleWalletValues;
  credentialsStored: boolean;
}) {
  const t = useTranslations('admin.wallet.google');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <SwitchRow
        name="enabled"
        defaultChecked={initial.enabled}
        label={t('enabled')}
        hint={t('enabledHint')}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <TextInput
          name="issuerId"
          label={t('issuerId')}
          hint={t('issuerIdHint')}
          defaultValue={initial.issuerId}
          error={err('issuerId')}
          maxLength={64}
          placeholder="3388000000012345678"
        />
        <TextInput
          name="classPrefix"
          label={t('classPrefix')}
          hint={t('classPrefixHint')}
          defaultValue={initial.classPrefix}
          error={err('classPrefix')}
          maxLength={32}
        />
      </div>
      <SecretTextArea
        name="serviceAccountJson"
        label={t('serviceAccountJson')}
        stored={credentialsStored}
        error={err('serviceAccountJson')}
        rows={6}
        hint={t('serviceAccountHint')}
      />
      {credentialsStored && (
        <SwitchRow name="clearCredentials" defaultChecked={false} label={t('clearCredentials')} />
      )}
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Configuration check ────────────────────────────────────────────────────

export function WalletCheck({
  action,
}: {
  action: (state: WalletCheckState) => Promise<WalletCheckState>;
}) {
  const t = useTranslations('admin.wallet.check');
  const [state, formAction] = useActionState(action, { status: 'idle' } as WalletCheckState);
  const issueText = (issue: WalletCheckIssue) => {
    const text = t(`issues.${issue.code}` as 'issues.passTypeMissing', issue.params);
    return issue.detail ? `${text}: ${issue.detail}` : text;
  };
  return (
    <ActionForm action={() => formAction()} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div>
        <h3 className="text-sm font-medium">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <SubmitButton variant="outline" pendingLabel={t('running')}>
        {t('button')}
      </SubmitButton>
      {state.status === 'done' && (
        <div className="space-y-2 text-sm">
          <Alert variant={state.ok ? 'default' : 'destructive'}>
            <AlertDescription>{state.ok ? t('ok') : t('failed')}</AlertDescription>
          </Alert>
          {state.errors.length > 0 && (
            <ul className="list-disc pl-5 text-destructive">
              {state.errors.map((e, i) => (
                <li key={i}>{issueText(e)}</li>
              ))}
            </ul>
          )}
          {state.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-amber-600">
              {state.warnings.map((e, i) => (
                <li key={i}>{issueText(e)}</li>
              ))}
            </ul>
          )}
          {state.details.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {state.details.map((d) => (
                <div key={d.label} className="contents">
                  <dt className="text-muted-foreground">{t(`details.${d.label}`)}</dt>
                  <dd className="font-mono break-all">{d.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </ActionForm>
  );
}

// ─── Pass design ────────────────────────────────────────────────────────────

export interface WalletDesignValues {
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
  logoText: string;
  description: string;
  logo: MediaPickerAsset | null;
  icon: MediaPickerAsset | null;
  strip: MediaPickerAsset | null;
}

function ColorInput({
  name,
  label,
  value,
  onChange,
  error,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: Parameters<typeof Field>[0]['error'];
}) {
  return (
    <Field label={label} htmlFor={`color-${name}`} error={error}>
      <div className="flex items-center gap-2">
        <input
          id={`color-${name}`}
          type="color"
          className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={7}
          className="font-mono uppercase"
          aria-label={label}
        />
      </div>
    </Field>
  );
}

export function WalletDesignForm({
  action,
  resetAction,
  initial,
  isOverride,
  inheritNote,
}: {
  action: Action;
  /** Present for event overrides: removes the override. */
  resetAction?: Action;
  initial: WalletDesignValues;
  /** Event form: whether a dedicated design exists (else the values shown are inherited). */
  isOverride?: boolean;
  inheritNote?: boolean;
}) {
  const t = useTranslations('admin.wallet.design');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [reset, resetFormAction] = useActionState(resetAction ?? (async () => IDLE), IDLE);
  const [bg, setBg] = useState(initial.backgroundColor);
  const [fg, setFg] = useState(initial.foregroundColor);
  const [label, setLabel] = useState(initial.labelColor);
  return (
    <div className="space-y-4">
      {inheritNote && !isOverride && (
        <Alert>
          <AlertDescription>{t('inheriting')}</AlertDescription>
        </Alert>
      )}
      <ActionForm action={formAction} className="space-y-5">
        <ActionFeedback state={state} />
        <div className="grid gap-4 md:grid-cols-3">
          <ColorInput
            name="backgroundColor"
            label={t('backgroundColor')}
            value={bg}
            onChange={setBg}
            error={err('backgroundColor')}
          />
          <ColorInput
            name="foregroundColor"
            label={t('foregroundColor')}
            value={fg}
            onChange={setFg}
            error={err('foregroundColor')}
          />
          <ColorInput
            name="labelColor"
            label={t('labelColor')}
            value={label}
            onChange={setLabel}
            error={err('labelColor')}
          />
        </div>
        <div
          className="flex items-center justify-between rounded-lg p-4 text-sm"
          style={{ backgroundColor: bg, color: fg }}
          aria-hidden
        >
          <div>
            <div className="text-xs" style={{ color: label }}>
              {t('previewLabel')}
            </div>
            <div className="text-base font-semibold">{t('previewValue')}</div>
          </div>
          <div className="size-12 rounded bg-white/90" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <TextInput
            name="logoText"
            label={t('logoText')}
            hint={t('logoTextHint')}
            defaultValue={initial.logoText}
            error={err('logoText')}
            maxLength={40}
          />
          <TextInput
            name="description"
            label={t('descriptionField')}
            hint={t('descriptionHint')}
            defaultValue={initial.description}
            error={err('description')}
            maxLength={200}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('imagesHint')}</p>
        <div className="grid gap-6 md:grid-cols-3">
          {(
            [
              ['logoAssetId', 'logo', initial.logo, 1],
              ['iconAssetId', 'icon', initial.icon, 1],
              ['stripAssetId', 'strip', initial.strip, 375 / 98],
            ] as const
          ).map(([name, key, asset, ratio]) => (
            <div key={name} className="space-y-1">
              <div className="text-sm font-medium">{t(`images.${key}`)}</div>
              <MediaPicker
                name={name}
                kind="WALLET_IMAGE"
                initialAsset={asset}
                aspectRatio={ratio}
                previewClassName="max-w-[12rem]"
              />
              <p className="text-xs text-muted-foreground">{t(`images.${key}Hint`)}</p>
            </div>
          ))}
        </div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </ActionForm>
      {resetAction && isOverride && (
        <ActionForm action={() => resetFormAction(new FormData())}>
          <ActionFeedback state={reset} />
          <Button type="submit" variant="outline" size="sm">
            {t('removeOverride')}
          </Button>
        </ActionForm>
      )}
    </div>
  );
}
