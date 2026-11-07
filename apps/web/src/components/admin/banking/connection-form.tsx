'use client';

import {
  BANK_STATEMENT_FORMATS,
  CSV_COLUMN_KEYS,
  CSV_DATE_FORMATS,
  STATEMENT_FORMAT_HINTS,
  type CsvProfile,
  type FileImportConfig,
  type FinApiConfig,
  type FinTsConfig,
  type FinTsTanMethodInfo,
  type ImapConfig,
  type SupportedBankAdapter,
} from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useActionState, useState, type ReactNode } from 'react';
import { ActionForm, NativeSelect, SubmitButton } from '@/components/admin/form-controls';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { BANKING_IDLE, type BankingActionState } from '@/lib/banking-action-state';
import { BankField, BankingFeedback, bankingError } from './banking-ui';

type Action = (state: BankingActionState, fd: FormData) => Promise<BankingActionState>;

export interface ConnectionFormValues {
  name: string;
  isActive: boolean;
  pollIntervalSeconds: number | null;
  /** Adapter config (defaults for new connections). */
  config: FinTsConfig | FinApiConfig | FileImportConfig | ImapConfig;
  /** Secrets are stored – inputs may stay empty. */
  hasSecrets: boolean;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {children}
    </fieldset>
  );
}

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <Switch name={name} defaultChecked={defaultChecked} />
      <span>
        {label}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

export function ConnectionForm({
  adapter,
  action,
  initial,
  minPollMinutes,
  tanMethods = [],
  submitLabel,
}: {
  adapter: SupportedBankAdapter;
  action: Action;
  initial: ConnectionFormValues;
  minPollMinutes: number;
  tanMethods?: FinTsTanMethodInfo[];
  submitLabel: string;
}) {
  const t = useTranslations('banking.connection');
  const [state, formAction] = useActionState(action, BANKING_IDLE);
  const err = (name: string) => bankingError(state, name);
  const secretHint = initial.hasSecrets ? t('fields.secretKeep') : t('fields.secretRequired');
  const config = initial.config;
  const pollError = err('pollIntervalMinutes');

  return (
    <ActionForm action={formAction} className="space-y-5">
      <BankingFeedback state={state} />
      <Section title={t('sections.general')}>
        <div className="grid gap-4 md:grid-cols-2">
          <BankField label={t('fields.name')} htmlFor="name" error={err('name')}>
            <Input id="name" name="name" defaultValue={initial.name} required maxLength={120} />
          </BankField>
          {adapter !== 'FILE_IMPORT' ? (
            <BankField
              label={t('fields.pollInterval')}
              htmlFor="pollIntervalMinutes"
              error={pollError}
              hint={t('fields.pollIntervalHint', { minutes: minPollMinutes })}
            >
              <Input
                id="pollIntervalMinutes"
                name="pollIntervalMinutes"
                type="number"
                min={minPollMinutes}
                step={1}
                defaultValue={
                  initial.pollIntervalSeconds ? Math.round(initial.pollIntervalSeconds / 60) : ''
                }
              />
            </BankField>
          ) : null}
        </div>
        <Toggle name="isActive" label={t('fields.isActive')} defaultChecked={initial.isActive} />
      </Section>

      {config.adapter === 'FINTS' ? (
        <FinTsFields config={config} err={err} secretHint={secretHint} tanMethods={tanMethods} />
      ) : null}
      {config.adapter === 'PSD2_FINAPI' ? (
        <FinApiFields config={config} err={err} secretHint={secretHint} />
      ) : null}
      {config.adapter === 'IMAP' ? (
        <ImapFields config={config} err={err} secretHint={secretHint} />
      ) : null}
      {config.adapter === 'FILE_IMPORT' ? (
        <Section title={t('sections.general')}>
          <BankField label={t('fields.formatHint')} htmlFor="formatHint" error={err('formatHint')}>
            <FormatHintSelect value={config.formatHint} />
          </BankField>
        </Section>
      ) : null}
      {config.adapter === 'FILE_IMPORT' || config.adapter === 'IMAP' ? (
        <CsvProfileFields profile={config.csvProfile} err={err} />
      ) : null}
      <SubmitButton>{submitLabel}</SubmitButton>
    </ActionForm>
  );
}

type Err = (name: string) => ReturnType<typeof bankingError>;

function FormatHintSelect({ value }: { value: string }) {
  const t = useTranslations('banking.format');
  return (
    <NativeSelect id="formatHint" name="formatHint" defaultValue={value}>
      {STATEMENT_FORMAT_HINTS.map((f) => (
        <option key={f} value={f}>
          {t(f)}
        </option>
      ))}
    </NativeSelect>
  );
}

function FinTsFields({
  config,
  err,
  secretHint,
  tanMethods,
}: {
  config: FinTsConfig;
  err: Err;
  secretHint: string;
  tanMethods: FinTsTanMethodInfo[];
}) {
  const t = useTranslations('banking.connection');
  const [methodId, setMethodId] = useState(config.tanMethodId ? String(config.tanMethodId) : '');
  const method = tanMethods.find((m) => String(m.id) === methodId);
  return (
    <>
      <Section title={t('sections.bank')}>
        <div className="grid gap-4 md:grid-cols-2">
          <BankField
            label={t('fields.serverUrl')}
            htmlFor="serverUrl"
            error={err('serverUrl')}
            hint={t('fields.serverUrlHint')}
            className="md:col-span-2"
          >
            <Input
              id="serverUrl"
              name="serverUrl"
              type="url"
              defaultValue={config.serverUrl}
              required
              placeholder="https://"
            />
          </BankField>
          <BankField label={t('fields.bankCode')} htmlFor="bankCode" error={err('bankCode')}>
            <Input
              id="bankCode"
              name="bankCode"
              defaultValue={config.bankCode}
              required
              inputMode="numeric"
              maxLength={10}
            />
          </BankField>
          <BankField label={t('fields.userId')} htmlFor="userId" error={err('userId')}>
            <Input
              id="userId"
              name="userId"
              defaultValue={config.userId}
              required
              maxLength={64}
              autoComplete="off"
            />
          </BankField>
          <BankField
            label={t('fields.customerId')}
            htmlFor="customerId"
            error={err('customerId')}
            hint={t('fields.customerIdHint')}
          >
            <Input
              id="customerId"
              name="customerId"
              defaultValue={config.customerId ?? ''}
              maxLength={64}
              autoComplete="off"
            />
          </BankField>
          <BankField
            label={t('fields.pin')}
            htmlFor="secret.pin"
            error={err('secret.pin')}
            hint={secretHint}
          >
            <Input
              id="secret.pin"
              name="secret.pin"
              type="password"
              autoComplete="new-password"
              maxLength={128}
            />
          </BankField>
          <BankField
            label={t('fields.productId')}
            htmlFor="productId"
            error={err('productId')}
            hint={t('fields.productIdHint')}
          >
            <Input
              id="productId"
              name="productId"
              defaultValue={config.productId}
              required
              maxLength={64}
              autoComplete="off"
            />
          </BankField>
          <BankField
            label={t('fields.productVersion')}
            htmlFor="productVersion"
            error={err('productVersion')}
          >
            <Input
              id="productVersion"
              name="productVersion"
              defaultValue={config.productVersion}
              maxLength={16}
            />
          </BankField>
          <BankField
            label={t('fields.lookbackDays')}
            htmlFor="lookbackDays"
            error={err('lookbackDays')}
            hint={t('fields.lookbackDaysHint')}
          >
            <Input
              id="lookbackDays"
              name="lookbackDays"
              type="number"
              min={1}
              max={730}
              defaultValue={config.lookbackDays}
            />
          </BankField>
        </div>
      </Section>
      <Section title={t('sections.tan')}>
        <div className="grid gap-4 md:grid-cols-2">
          <BankField
            label={t('fields.tanMethod')}
            htmlFor="tanMethodId"
            error={err('tanMethodId')}
            hint={t('fields.tanMethodHint')}
          >
            {tanMethods.length > 0 ? (
              <NativeSelect
                id="tanMethodId"
                name="tanMethodId"
                value={methodId}
                onChange={(e) => setMethodId(e.target.value)}
              >
                <option value="">{t('fields.tanMethodAuto')}</option>
                {tanMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.id})
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <Input
                id="tanMethodId"
                name="tanMethodId"
                type="number"
                min={1}
                max={999}
                defaultValue={config.tanMethodId ?? ''}
                placeholder={t('fields.tanMethodNone')}
              />
            )}
          </BankField>
          <BankField
            label={t('fields.tanMedium')}
            htmlFor="tanMediumName"
            error={err('tanMediumName')}
            hint={t('fields.tanMediumHint')}
          >
            <Input
              id="tanMediumName"
              name="tanMediumName"
              defaultValue={config.tanMediumName ?? ''}
              maxLength={64}
              list="tan-media"
            />
            <datalist id="tan-media">
              {(method?.activeTanMedia ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </BankField>
        </div>
        <Toggle
          name="preferCamt"
          label={t('fields.preferCamt')}
          hint={t('fields.preferCamtHint')}
          defaultChecked={config.preferCamt}
        />
      </Section>
    </>
  );
}

function FinApiFields({
  config,
  err,
  secretHint,
}: {
  config: FinApiConfig;
  err: Err;
  secretHint: string;
}) {
  const t = useTranslations('banking.connection');
  return (
    <Section title={t('sections.provider')}>
      <div className="grid gap-4 md:grid-cols-2">
        <BankField label={t('fields.environment')} htmlFor="environment" error={err('environment')}>
          <NativeSelect id="environment" name="environment" defaultValue={config.environment}>
            <option value="sandbox">{t('fields.sandbox')}</option>
            <option value="live">{t('fields.live')}</option>
          </NativeSelect>
        </BankField>
        <BankField label={t('fields.clientId')} htmlFor="clientId" error={err('clientId')}>
          <Input
            id="clientId"
            name="clientId"
            defaultValue={config.clientId}
            required
            maxLength={128}
            autoComplete="off"
          />
        </BankField>
        <BankField
          label={t('fields.clientSecret')}
          htmlFor="secret.clientSecret"
          error={err('secret.clientSecret')}
          hint={secretHint}
        >
          <Input
            id="secret.clientSecret"
            name="secret.clientSecret"
            type="password"
            autoComplete="new-password"
            maxLength={512}
          />
        </BankField>
        <BankField
          label={t('fields.webFormProfileId')}
          htmlFor="webFormProfileId"
          error={err('webFormProfileId')}
        >
          <Input
            id="webFormProfileId"
            name="webFormProfileId"
            defaultValue={config.webFormProfileId ?? ''}
            maxLength={36}
          />
        </BankField>
        <BankField
          label={t('fields.lookbackDays')}
          htmlFor="lookbackDays"
          error={err('lookbackDays')}
          hint={t('fields.lookbackDaysHint')}
        >
          <Input
            id="lookbackDays"
            name="lookbackDays"
            type="number"
            min={1}
            max={730}
            defaultValue={config.lookbackDays}
          />
        </BankField>
      </div>
      <Toggle
        name="backgroundUpdate"
        label={t('fields.backgroundUpdate')}
        hint={t('fields.backgroundUpdateHint')}
        defaultChecked={config.backgroundUpdate}
      />
    </Section>
  );
}

function ImapFields({
  config,
  err,
  secretHint,
}: {
  config: ImapConfig;
  err: Err;
  secretHint: string;
}) {
  const t = useTranslations('banking.connection');
  const tf = useTranslations('banking.format');
  return (
    <>
      <Section title={t('sections.mailbox')}>
        <div className="grid gap-4 md:grid-cols-2">
          <BankField label={t('fields.host')} htmlFor="host" error={err('host')}>
            <Input id="host" name="host" defaultValue={config.host} required maxLength={255} />
          </BankField>
          <BankField label={t('fields.port')} htmlFor="port" error={err('port')}>
            <Input
              id="port"
              name="port"
              type="number"
              min={1}
              max={65535}
              defaultValue={config.port}
            />
          </BankField>
          <BankField label={t('fields.username')} htmlFor="username" error={err('username')}>
            <Input
              id="username"
              name="username"
              defaultValue={config.username}
              required
              maxLength={255}
              autoComplete="off"
            />
          </BankField>
          <BankField
            label={t('fields.password')}
            htmlFor="secret.password"
            error={err('secret.password')}
            hint={secretHint}
          >
            <Input
              id="secret.password"
              name="secret.password"
              type="password"
              autoComplete="new-password"
              maxLength={512}
            />
          </BankField>
          <BankField label={t('fields.mailbox')} htmlFor="mailbox" error={err('mailbox')}>
            <Input id="mailbox" name="mailbox" defaultValue={config.mailbox} maxLength={255} />
          </BankField>
          <BankField
            label={t('fields.processedMailbox')}
            htmlFor="processedMailbox"
            error={err('processedMailbox')}
            hint={t('fields.processedMailboxHint')}
          >
            <Input
              id="processedMailbox"
              name="processedMailbox"
              defaultValue={config.processedMailbox ?? ''}
              maxLength={255}
            />
          </BankField>
        </div>
        <Toggle
          name="secure"
          label={t('fields.secure')}
          hint={t('fields.secureHint')}
          defaultChecked={config.secure}
        />
      </Section>
      <Section title={t('sections.filters')}>
        <div className="grid gap-4 md:grid-cols-2">
          <BankField
            label={t('fields.senderAllowlist')}
            htmlFor="senderAllowlist"
            error={err('senderAllowlist')}
            hint={t('fields.senderAllowlistHint')}
          >
            <Textarea
              id="senderAllowlist"
              name="senderAllowlist"
              rows={3}
              defaultValue={config.senderAllowlist.join('\n')}
            />
          </BankField>
          <div className="space-y-4">
            <BankField
              label={t('fields.subjectFilter')}
              htmlFor="subjectFilter"
              error={err('subjectFilter')}
            >
              <Input
                id="subjectFilter"
                name="subjectFilter"
                defaultValue={config.subjectFilter ?? ''}
                maxLength={255}
              />
            </BankField>
            <BankField
              label={t('fields.lookbackDays')}
              htmlFor="lookbackDays"
              error={err('lookbackDays')}
            >
              <Input
                id="lookbackDays"
                name="lookbackDays"
                type="number"
                min={1}
                max={365}
                defaultValue={config.lookbackDays}
              />
            </BankField>
          </div>
        </div>
        <BankField label={t('fields.attachmentFormats')} error={err('attachmentFormats')}>
          <div className="flex flex-wrap gap-4">
            {BANK_STATEMENT_FORMATS.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name={`attachmentFormats.${f}`}
                  defaultChecked={config.attachmentFormats.includes(f)}
                />
                {tf(f)}
              </label>
            ))}
          </div>
        </BankField>
      </Section>
    </>
  );
}

function CsvProfileFields({ profile, err }: { profile: CsvProfile; err: Err }) {
  const t = useTranslations('banking.connection.csv');
  const ts = useTranslations('banking.connection.sections');
  const delimiter = profile.delimiter === '\t' ? 'tab' : profile.delimiter;
  return (
    <Section title={ts('csv')}>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <div className="grid gap-4 md:grid-cols-3">
        <BankField
          label={t('delimiter')}
          htmlFor="csv-delimiter"
          error={err('csvProfile.delimiter')}
        >
          <NativeSelect id="csv-delimiter" name="csvProfile.delimiter" defaultValue={delimiter}>
            <option value="auto">{t('auto')}</option>
            <option value=";">{t('semicolon')} (;)</option>
            <option value=",">{t('comma')} (,)</option>
            <option value="tab">{t('tab')}</option>
          </NativeSelect>
        </BankField>
        <BankField label={t('encoding')} htmlFor="csv-encoding" error={err('csvProfile.encoding')}>
          <NativeSelect
            id="csv-encoding"
            name="csvProfile.encoding"
            defaultValue={profile.encoding}
          >
            <option value="auto">{t('auto')}</option>
            <option value="utf-8">UTF-8</option>
            <option value="windows-1252">Windows-1252</option>
            <option value="iso-8859-1">ISO-8859-1</option>
          </NativeSelect>
        </BankField>
        <BankField
          label={t('headerRow')}
          htmlFor="csv-headerRow"
          error={err('csvProfile.headerRow')}
          hint={t('headerRowHint')}
        >
          <Input
            id="csv-headerRow"
            name="csvProfile.headerRow"
            type="number"
            min={1}
            max={50}
            defaultValue={profile.headerRow ?? ''}
          />
        </BankField>
        <BankField
          label={t('dateFormat')}
          htmlFor="csv-dateFormat"
          error={err('csvProfile.dateFormat')}
        >
          <NativeSelect
            id="csv-dateFormat"
            name="csvProfile.dateFormat"
            defaultValue={profile.dateFormat}
          >
            {CSV_DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f === 'auto' ? t('auto') : f}
              </option>
            ))}
          </NativeSelect>
        </BankField>
        <BankField
          label={t('decimalSeparator')}
          htmlFor="csv-decimal"
          error={err('csvProfile.decimalSeparator')}
        >
          <NativeSelect
            id="csv-decimal"
            name="csvProfile.decimalSeparator"
            defaultValue={profile.decimalSeparator}
          >
            <option value="auto">{t('auto')}</option>
            <option value=",">{t('comma')} (1.234,56)</option>
            <option value=".">{t('dot')} (1,234.56)</option>
          </NativeSelect>
        </BankField>
      </div>
      <details
        className="rounded-md border p-3"
        open={Object.values(profile.columns).some(Boolean)}
      >
        <summary className="cursor-pointer text-sm font-medium">{t('columnsTitle')}</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {CSV_COLUMN_KEYS.map((key) => (
            <BankField
              key={key}
              label={t(`column.${key}`)}
              htmlFor={`csv-col-${key}`}
              error={err(`csvProfile.columns.${key}`)}
            >
              <Input
                id={`csv-col-${key}`}
                name={`csvProfile.columns.${key}`}
                defaultValue={profile.columns[key] ?? ''}
                maxLength={100}
                placeholder={t('auto')}
              />
            </BankField>
          ))}
        </div>
      </details>
    </Section>
  );
}
