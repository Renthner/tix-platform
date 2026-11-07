'use client';

import { GERMAN_STATES, SMTP_SECURITY_MODES, SUPPORTED_LOCALES } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { centsToInput } from '@/lib/money';
import type { TestMailState } from '@/server/admin/settings';
import { ActionFeedback, ActionForm, Field, NativeSelect, SubmitButton } from './form-controls';
import { SwitchRow, useSettingsForm, type Action } from './settings-forms';

/* Settings of phase 3: organizer (seller data), invoicing, bank transfer (Vorkasse), PayPal,
 * SMTP incl. test e-mail and customer accounts. Secrets are write-only: the page only knows
 * whether one is stored; a new value replaces it, the switch removes it. */

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
  defaultValue: number | string;
  min?: number;
  max?: number;
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

function TextField({
  name,
  label,
  hint,
  defaultValue,
  error,
  type = 'text',
  maxLength,
  placeholder,
  className,
  autoComplete,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string | null;
  error?: Parameters<typeof Field>[0]['error'];
  type?: string;
  maxLength?: number;
  placeholder?: string;
  className?: string;
  autoComplete?: string;
}) {
  return (
    <Field label={label} htmlFor={name} error={error} hint={hint} className={className}>
      <Input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete={autoComplete ?? 'off'}
      />
    </Field>
  );
}

function SecretStatus({ stored }: { stored: boolean }) {
  const t = useTranslations('admin.settings.secret');
  return stored ? (
    <Badge variant="secondary">{t('stored')}</Badge>
  ) : (
    <Badge variant="outline">{t('notSet')}</Badge>
  );
}

// ─── Organizer (seller data on invoices) ────────────────────────────────────

export interface OrganizerValues {
  legalName?: string;
  street?: string;
  postalCode?: string;
  city?: string;
  country: string;
  vatId?: string;
  taxNumber?: string;
  registerCourt?: string;
  registerNumber?: string;
  representatives?: string;
  email?: string;
  phone?: string;
  website?: string;
}

export function OrganizerSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: OrganizerValues;
}) {
  const t = useTranslations('admin.settings.organizer');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const field = (name: keyof OrganizerValues, extra: { hint?: string; type?: string } = {}) => (
    <TextField
      name={name}
      label={t(name)}
      defaultValue={initial[name]}
      error={err(name)}
      {...extra}
    />
  );
  return (
    <ActionForm action={formAction} className="space-y-4">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          name="legalName"
          label={t('legalName')}
          hint={t('legalNameHint')}
          defaultValue={initial.legalName}
          error={err('legalName')}
          className="md:col-span-2"
        />
        {field('street')}
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          {field('postalCode')}
          {field('city')}
        </div>
        <TextField
          name="country"
          label={t('country')}
          hint={t('countryHint')}
          defaultValue={initial.country}
          error={err('country')}
          maxLength={2}
        />
        {field('email', { type: 'email' })}
        {field('phone')}
        {field('website', { type: 'url' })}
        {field('vatId', { hint: t('vatIdHint') })}
        {field('taxNumber', { hint: t('taxNumberHint') })}
        {field('registerCourt')}
        {field('registerNumber')}
        <Field
          label={t('representatives')}
          htmlFor="representatives"
          error={err('representatives')}
          hint={t('representativesHint')}
          className="md:col-span-2"
        >
          <Input
            id="representatives"
            name="representatives"
            defaultValue={initial.representatives ?? ''}
            maxLength={500}
          />
        </Field>
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Invoicing ──────────────────────────────────────────────────────────────

export interface InvoicingValues {
  issueInvoices: boolean;
  orderNumberPattern: string;
  invoiceNumberPattern: string;
  creditNoteNumberPattern: string;
  invoiceFooter?: string;
}

export function InvoicingSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: InvoicingValues;
}) {
  const t = useTranslations('admin.settings.invoicing');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  return (
    <ActionForm action={formAction} className="space-y-4">
      <ActionFeedback state={state} />
      <SwitchRow
        name="issueInvoices"
        defaultChecked={initial.issueInvoices}
        label={t('issueInvoices')}
        hint={t('issueInvoicesHint')}
      />
      <div className="grid gap-4 md:grid-cols-3">
        {(['orderNumberPattern', 'invoiceNumberPattern', 'creditNoteNumberPattern'] as const).map(
          (name) => (
            <Field key={name} label={t(name)} htmlFor={name} error={err(name)}>
              <Input
                id={name}
                name={name}
                defaultValue={initial[name]}
                maxLength={64}
                required
                className="font-mono"
              />
            </Field>
          ),
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('patternHint')}</p>
      <Alert>
        <AlertDescription>{t('gapless')}</AlertDescription>
      </Alert>
      <Field
        label={t('invoiceFooter')}
        htmlFor="invoiceFooter"
        error={err('invoiceFooter')}
        hint={t('invoiceFooterHint')}
      >
        <Textarea
          id="invoiceFooter"
          name="invoiceFooter"
          rows={3}
          maxLength={4000}
          defaultValue={initial.invoiceFooter ?? ''}
        />
      </Field>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Bank transfer (Vorkasse) ───────────────────────────────────────────────

export interface BankTransferValues {
  enabled: boolean;
  paymentReferencePrefix: string;
  paymentTermDays: number;
  countBusinessDaysOnly: boolean;
  holidayRegion: string | null;
  reminderAfterDays: number;
  cancelAfterDays: number;
  disableDaysBeforeEvent: number;
  autoMatchToleranceCents: number;
}

export function BankTransferSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: BankTransferValues;
}) {
  const t = useTranslations('admin.settings.bankTransfer');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [prefix, setPrefix] = useState(initial.paymentReferencePrefix);
  const example = `${/^[A-Z]{2,6}$/.test(prefix) ? prefix : 'TIX'}-${new Date().getFullYear()}-8492-7`;
  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <Alert>
        <AlertDescription>{t('overrideNotice')}</AlertDescription>
      </Alert>
      <SwitchRow
        name="enabled"
        defaultChecked={initial.enabled}
        label={t('enabled')}
        hint={t('enabledHint')}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label={t('paymentReferencePrefix')}
          htmlFor="paymentReferencePrefix"
          error={err('paymentReferencePrefix')}
          hint={t('paymentReferencePrefixHint', { example })}
        >
          <Input
            id="paymentReferencePrefix"
            name="paymentReferencePrefix"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
            maxLength={6}
            required
            className="font-mono uppercase"
          />
        </Field>
        <Field
          label={t('autoMatchTolerance')}
          htmlFor="autoMatchTolerance"
          error={err('autoMatchTolerance')}
          hint={t('autoMatchToleranceHint')}
        >
          <Input
            id="autoMatchTolerance"
            name="autoMatchTolerance"
            inputMode="decimal"
            defaultValue={centsToInput(initial.autoMatchToleranceCents)}
          />
        </Field>
        <NumberField
          name="paymentTermDays"
          label={t('paymentTermDays')}
          hint={t('paymentTermDaysHint')}
          defaultValue={initial.paymentTermDays}
          min={1}
          max={60}
          error={err('paymentTermDays')}
        />
        <Field
          label={t('holidayRegion')}
          htmlFor="holidayRegion"
          error={err('holidayRegion')}
          hint={t('holidayRegionHint')}
        >
          <NativeSelect
            id="holidayRegion"
            name="holidayRegion"
            defaultValue={initial.holidayRegion ?? ''}
          >
            <option value="">{t('regions.nationwide')}</option>
            {GERMAN_STATES.map((state) => (
              <option key={state} value={state}>
                {t(`regions.${state}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <NumberField
          name="reminderAfterDays"
          label={t('reminderAfterDays')}
          hint={t('reminderAfterDaysHint')}
          defaultValue={initial.reminderAfterDays}
          min={1}
          max={60}
          error={err('reminderAfterDays')}
        />
        <NumberField
          name="cancelAfterDays"
          label={t('cancelAfterDays')}
          hint={t('cancelAfterDaysHint')}
          defaultValue={initial.cancelAfterDays}
          min={1}
          max={90}
          error={err('cancelAfterDays')}
        />
        <NumberField
          name="disableDaysBeforeEvent"
          label={t('disableDaysBeforeEvent')}
          hint={t('disableDaysBeforeEventHint')}
          defaultValue={initial.disableDaysBeforeEvent}
          min={0}
          max={90}
          error={err('disableDaysBeforeEvent')}
        />
      </div>
      <SwitchRow
        name="countBusinessDaysOnly"
        defaultChecked={initial.countBusinessDaysOnly}
        label={t('countBusinessDaysOnly')}
        hint={t('countBusinessDaysOnlyHint')}
      />
      <p className="text-xs text-muted-foreground">{t('bankAccountNotice')}</p>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── PayPal ─────────────────────────────────────────────────────────────────

export interface PaypalValues {
  enabled: boolean;
  environment: 'sandbox' | 'live';
  clientId?: string;
  webhookId?: string;
  brandName?: string;
  approvalTimeoutSeconds: number;
}

export function PaypalSettingsForm({
  action,
  initial,
  secretStored,
}: {
  action: Action;
  initial: PaypalValues;
  secretStored: boolean;
}) {
  const t = useTranslations('admin.settings.paypal');
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
        <Field
          label={t('environment')}
          htmlFor="environment"
          error={err('environment')}
          hint={t('environmentHint')}
        >
          <NativeSelect id="environment" name="environment" defaultValue={initial.environment}>
            <option value="sandbox">{t('environments.sandbox')}</option>
            <option value="live">{t('environments.live')}</option>
          </NativeSelect>
        </Field>
        <TextField
          name="brandName"
          label={t('brandName')}
          hint={t('brandNameHint')}
          defaultValue={initial.brandName}
          error={err('brandName')}
          maxLength={127}
        />
        <TextField
          name="clientId"
          label={t('clientId')}
          defaultValue={initial.clientId}
          error={err('clientId')}
          maxLength={256}
        />
        <Field
          label={
            <span className="flex items-center gap-2">
              {t('clientSecret')} <SecretStatus stored={secretStored} />
            </span>
          }
          htmlFor="clientSecret"
          error={err('clientSecret')}
          hint={secretStored ? ts('replaceHint') : ts('enterHint')}
        >
          <Input
            id="clientSecret"
            name="clientSecret"
            type="password"
            autoComplete="new-password"
            placeholder={secretStored ? ts('storedPlaceholder') : ''}
          />
        </Field>
        <TextField
          name="webhookId"
          label={t('webhookId')}
          hint={t('webhookIdHint')}
          defaultValue={initial.webhookId}
          error={err('webhookId')}
          maxLength={128}
        />
        <NumberField
          name="approvalTimeoutSeconds"
          label={t('approvalTimeoutSeconds')}
          hint={t('approvalTimeoutSecondsHint')}
          defaultValue={initial.approvalTimeoutSeconds}
          min={300}
          max={10800}
          error={err('approvalTimeoutSeconds')}
        />
      </div>
      {secretStored && (
        <SwitchRow name="clearClientSecret" defaultChecked={false} label={t('clearClientSecret')} />
      )}
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── SMTP + test e-mail ─────────────────────────────────────────────────────

export interface SmtpValues {
  host?: string;
  port: number;
  security: (typeof SMTP_SECURITY_MODES)[number];
  username?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  bccAddress?: string;
}

export function SmtpSettingsForm({
  action,
  initial,
  passwordStored,
}: {
  action: Action;
  initial: SmtpValues;
  passwordStored: boolean;
}) {
  const t = useTranslations('admin.settings.smtp');
  const ts = useTranslations('admin.settings.secret');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  return (
    <ActionForm action={formAction} className="space-y-5" autoComplete="off">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          name="host"
          label={t('host')}
          hint={t('hostHint')}
          defaultValue={initial.host}
          error={err('host')}
          maxLength={255}
          placeholder="smtp.example.org"
        />
        <div className="grid grid-cols-[7rem_1fr] gap-3">
          <NumberField
            name="port"
            label={t('port')}
            defaultValue={initial.port}
            min={1}
            max={65535}
            error={err('port')}
          />
          <Field label={t('security')} htmlFor="security" error={err('security')}>
            <NativeSelect id="security" name="security" defaultValue={initial.security}>
              {SMTP_SECURITY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`securityModes.${mode}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <TextField
          name="username"
          label={t('username')}
          hint={t('usernameHint')}
          defaultValue={initial.username}
          error={err('username')}
          maxLength={255}
          autoComplete="off"
        />
        <Field
          label={
            <span className="flex items-center gap-2">
              {t('password')} <SecretStatus stored={passwordStored} />
            </span>
          }
          htmlFor="password"
          error={err('password')}
          hint={passwordStored ? ts('replaceHint') : ts('enterHint')}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={passwordStored ? ts('storedPlaceholder') : ''}
          />
        </Field>
        <TextField
          name="fromName"
          label={t('fromName')}
          hint={t('fromNameHint')}
          defaultValue={initial.fromName}
          error={err('fromName')}
          maxLength={120}
        />
        <TextField
          name="fromEmail"
          label={t('fromEmail')}
          hint={t('fromEmailHint')}
          type="email"
          defaultValue={initial.fromEmail}
          error={err('fromEmail')}
        />
        <TextField
          name="replyTo"
          label={t('replyTo')}
          hint={t('replyToHint')}
          type="email"
          defaultValue={initial.replyTo}
          error={err('replyTo')}
        />
        <TextField
          name="bccAddress"
          label={t('bccAddress')}
          hint={t('bccAddressHint')}
          type="email"
          defaultValue={initial.bccAddress}
          error={err('bccAddress')}
        />
      </div>
      {passwordStored && (
        <SwitchRow name="clearPassword" defaultChecked={false} label={t('clearPassword')} />
      )}
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

export function SmtpTestForm({
  action,
  defaultRecipient,
  defaultLocale,
}: {
  action: (state: TestMailState, fd: FormData) => Promise<TestMailState>;
  defaultRecipient: string;
  defaultLocale: string;
}) {
  const t = useTranslations('admin.settings.smtp.test');
  const tl = useTranslations('common.locale');
  const [state, formAction] = useActionState(action, { status: 'idle' } as TestMailState);
  return (
    <ActionForm action={formAction} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div>
        <h3 className="text-sm font-medium">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <Field
          label={t('recipient')}
          htmlFor="testRecipient"
          error={state.status === 'error' && state.code === 'email' ? 'email' : undefined}
        >
          <Input
            id="testRecipient"
            name="testRecipient"
            type="email"
            defaultValue={defaultRecipient}
            required
          />
        </Field>
        <Field label={t('language')} htmlFor="testLocale">
          <NativeSelect
            id="testLocale"
            name="locale"
            defaultValue={
              (SUPPORTED_LOCALES as readonly string[]).includes(defaultLocale)
                ? defaultLocale
                : SUPPORTED_LOCALES[0]
            }
          >
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l} value={l}>
                {tl(l)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <SubmitButton variant="outline" pendingLabel={t('sending')}>
          {t('send')}
        </SubmitButton>
      </div>
      {state.status === 'success' && (
        <Alert>
          <AlertDescription>{t('success', { to: state.to })}</AlertDescription>
        </Alert>
      )}
      {state.status === 'error' && state.code === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>
            <span className="block font-medium">{t('failed')}</span>
            {state.message && (
              <span className="mt-1 block font-mono text-xs break-all">{state.message}</span>
            )}
          </AlertDescription>
        </Alert>
      )}
    </ActionForm>
  );
}

// ─── Customer accounts ──────────────────────────────────────────────────────

export interface CustomerAccountsValues {
  enabled: boolean;
  guestCheckoutEnabled: boolean;
  loginLinkEnabled: boolean;
  sessionTtlDays: number;
  passwordMinLength: number;
  emailVerificationTtlHours: number;
  passwordResetTtlMinutes: number;
}

export function CustomerAccountsSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: CustomerAccountsValues;
}) {
  const t = useTranslations('admin.settings.customerAccounts');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <div className="space-y-3">
        <SwitchRow
          name="enabled"
          defaultChecked={initial.enabled}
          label={t('enabled')}
          hint={t('enabledHint')}
        />
        <SwitchRow
          name="guestCheckoutEnabled"
          defaultChecked={initial.guestCheckoutEnabled}
          label={t('guestCheckoutEnabled')}
          hint={t('guestCheckoutEnabledHint')}
        />
        <SwitchRow
          name="loginLinkEnabled"
          defaultChecked={initial.loginLinkEnabled}
          label={t('loginLinkEnabled')}
          hint={t('loginLinkEnabledHint')}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <NumberField
          name="sessionTtlDays"
          label={t('sessionTtlDays')}
          defaultValue={initial.sessionTtlDays}
          min={1}
          max={365}
          error={err('sessionTtlDays')}
        />
        <NumberField
          name="passwordMinLength"
          label={t('passwordMinLength')}
          defaultValue={initial.passwordMinLength}
          min={8}
          max={128}
          error={err('passwordMinLength')}
        />
        <NumberField
          name="emailVerificationTtlHours"
          label={t('emailVerificationTtlHours')}
          defaultValue={initial.emailVerificationTtlHours}
          min={1}
          max={168}
          error={err('emailVerificationTtlHours')}
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
