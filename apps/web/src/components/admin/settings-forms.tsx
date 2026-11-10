'use client';

import { SEAT_SELECTION_STYLES, SUPPORTED_LOCALES, type SeatSelectionStyle } from '@tix/shared';
import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  ActionForm,
  ActionFeedback,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';
import { MediaPicker, type MediaPickerAsset } from './media-picker';
import { RichTextEditor } from './rich-text-editor';
import { TimeZoneOptions } from './venue-form';

export type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export function useSettingsForm(action: Action) {
  const [state, formAction] = useActionState(action, IDLE);
  return { state, formAction, err: (name: string) => errorOf(state, name) };
}

export function SwitchRow({
  name,
  defaultChecked,
  label,
  hint,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <Switch name={name} defaultChecked={defaultChecked} className="mt-0.5" />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function ColorField({
  name,
  label,
  value,
  onChange,
  error,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: ReturnType<typeof errorOf>;
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
          maxLength={9}
          className="font-mono uppercase"
          aria-label={label}
        />
      </div>
    </Field>
  );
}

// ─── General ────────────────────────────────────────────────────────────────

export interface GeneralValues {
  shopName: string;
  defaultLocale: string;
  defaultCurrency: string;
  defaultTimeZone: string;
  supportEmail?: string;
}

export function GeneralSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: GeneralValues;
}) {
  const t = useTranslations('admin.settings.general');
  const tl = useTranslations('common.locale');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  return (
    <ActionForm action={formAction} className="space-y-4">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label={t('shopName')}
          htmlFor="shopName"
          error={err('shopName')}
          hint={t('shopNameHint')}
        >
          <Input
            id="shopName"
            name="shopName"
            defaultValue={initial.shopName}
            required
            maxLength={120}
          />
        </Field>
        <Field label={t('supportEmail')} htmlFor="supportEmail" error={err('supportEmail')}>
          <Input
            id="supportEmail"
            name="supportEmail"
            type="email"
            defaultValue={initial.supportEmail ?? ''}
          />
        </Field>
        <Field
          label={t('defaultLocale')}
          htmlFor="defaultLocale"
          error={err('defaultLocale')}
          hint={t('defaultLocaleHint')}
        >
          <NativeSelect
            id="defaultLocale"
            name="defaultLocale"
            defaultValue={initial.defaultLocale}
          >
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l} value={l}>
                {tl(l)}
              </option>
            ))}
            {!(SUPPORTED_LOCALES as readonly string[]).includes(initial.defaultLocale) && (
              <option value={initial.defaultLocale}>{initial.defaultLocale}</option>
            )}
          </NativeSelect>
        </Field>
        <Field
          label={t('defaultCurrency')}
          htmlFor="defaultCurrency"
          error={err('defaultCurrency')}
          hint={t('defaultCurrencyHint')}
        >
          <Input
            id="defaultCurrency"
            name="defaultCurrency"
            defaultValue={initial.defaultCurrency}
            maxLength={3}
            required
            className="uppercase"
          />
        </Field>
        <Field
          label={t('defaultTimeZone')}
          htmlFor="defaultTimeZone"
          error={err('defaultTimeZone')}
          hint={t('defaultTimeZoneHint')}
        >
          <Input
            id="defaultTimeZone"
            name="defaultTimeZone"
            list="tz-list"
            defaultValue={initial.defaultTimeZone}
            required
          />
        </Field>
      </div>
      <TimeZoneOptions />
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Branding ───────────────────────────────────────────────────────────────

export interface BrandingValues {
  logo: MediaPickerAsset | null;
  favicon: MediaPickerAsset | null;
  primaryColor: string;
  accentColor: string;
  imprintUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  footerText?: string;
}

export function BrandingSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: BrandingValues;
}) {
  const t = useTranslations('admin.settings.branding');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [primary, setPrimary] = useState(initial.primaryColor);
  const [accent, setAccent] = useState(initial.accentColor);
  return (
    <ActionForm action={formAction} className="space-y-4">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label={t('logo')}
          htmlFor="logoAssetId"
          error={err('logoAssetId')}
          hint={t('logoHint')}
        >
          <MediaPicker
            name="logoAssetId"
            kind="LOGO"
            initialAsset={initial.logo}
            previewClassName="max-w-xs"
            previewAlt={t('logo')}
          />
        </Field>
        <Field
          label={t('favicon')}
          htmlFor="faviconAssetId"
          error={err('faviconAssetId')}
          hint={t('faviconHint')}
        >
          <MediaPicker
            name="faviconAssetId"
            kind="LOGO"
            initialAsset={initial.favicon}
            aspectRatio={1}
            previewClassName="max-w-32"
            previewAlt={t('favicon')}
          />
        </Field>
        <ColorField
          name="primaryColor"
          label={t('primaryColor')}
          value={primary}
          onChange={setPrimary}
          error={err('primaryColor')}
        />
        <ColorField
          name="accentColor"
          label={t('accentColor')}
          value={accent}
          onChange={setAccent}
          error={err('accentColor')}
        />
        <Field label={t('imprintUrl')} htmlFor="imprintUrl" error={err('imprintUrl')}>
          <Input
            id="imprintUrl"
            name="imprintUrl"
            type="url"
            defaultValue={initial.imprintUrl ?? ''}
            placeholder="https://"
          />
        </Field>
        <Field label={t('privacyUrl')} htmlFor="privacyUrl" error={err('privacyUrl')}>
          <Input
            id="privacyUrl"
            name="privacyUrl"
            type="url"
            defaultValue={initial.privacyUrl ?? ''}
            placeholder="https://"
          />
        </Field>
        <Field label={t('termsUrl')} htmlFor="termsUrl" error={err('termsUrl')}>
          <Input
            id="termsUrl"
            name="termsUrl"
            type="url"
            defaultValue={initial.termsUrl ?? ''}
            placeholder="https://"
          />
        </Field>
        <Field
          label={t('footerText')}
          htmlFor="footerText"
          error={err('footerText')}
          className="md:col-span-2"
        >
          <RichTextEditor
            id="footerText"
            name="footerText"
            compact
            defaultValue={initial.footerText ?? ''}
            invalid={!!err('footerText')}
          />
        </Field>
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Seat selection & cart ──────────────────────────────────────────────────

export interface CheckoutValues {
  cartLockTtlSeconds: number;
  paymentGraceSeconds: number;
  maxTicketsPerOrder: number | null;
  maxTicketsPerCustomer: number | null;
  manualSeatSelectionEnabled: boolean;
  bestAvailableEnabled: boolean;
  orphanSeatRuleEnabled: boolean;
  companionSeatsRequireWheelchair: boolean;
  requireTermsAcceptance: boolean;
  requirePhone: boolean;
  requireBillingAddress: boolean;
  refundFeesByDefault: boolean;
}

export function CheckoutSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: CheckoutValues;
}) {
  const t = useTranslations('admin.settings.checkout');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [ttl, setTtl] = useState(String(initial.cartLockTtlSeconds));
  const [grace, setGrace] = useState(String(initial.paymentGraceSeconds));
  const minuteValue = (seconds: string) => {
    const n = Number(seconds);
    return Number.isFinite(n) && n >= 0 ? Math.round((n / 60) * 10) / 10 : 0;
  };
  const minutes = (seconds: string) => {
    const n = Number(seconds);
    return Number.isFinite(n) && n > 0 ? t('minutes', { value: minuteValue(seconds) }) : undefined;
  };
  const withMinutes = (seconds: string, hint: string) =>
    [minutes(seconds), hint].filter(Boolean).join(' · ');
  const ttlMinutes = minuteValue(ttl);
  const graceMinutes = minuteValue(grace);
  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <Alert>
        <AlertDescription>{t('overrideNotice')}</AlertDescription>
      </Alert>
      <div className="rounded-lg border bg-muted/40 p-4 text-sm">
        <div className="mb-2 flex items-center gap-2 font-medium">
          <Clock className="size-4" /> {t('timeline.title')}
        </div>
        <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
          <li>{t('timeline.cart', { minutes: ttlMinutes })}</li>
          <li>
            {graceMinutes > 0
              ? t('timeline.checkout', { minutes: graceMinutes, total: ttlMinutes + graceMinutes })
              : t('timeline.checkoutNone')}
          </li>
          <li>{t('timeline.order')}</li>
        </ol>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label={t('cartLockTtlSeconds')}
          htmlFor="cartLockTtlSeconds"
          error={err('cartLockTtlSeconds')}
          hint={withMinutes(ttl, t('cartLockTtlHint'))}
        >
          <Input
            id="cartLockTtlSeconds"
            name="cartLockTtlSeconds"
            type="number"
            min={60}
            max={3600}
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            required
          />
        </Field>
        <Field
          label={t('paymentGraceSeconds')}
          htmlFor="paymentGraceSeconds"
          error={err('paymentGraceSeconds')}
          hint={withMinutes(grace, t('paymentGraceHint'))}
        >
          <Input
            id="paymentGraceSeconds"
            name="paymentGraceSeconds"
            type="number"
            min={0}
            max={3600}
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
            required
          />
        </Field>
        <Field
          label={t('maxTicketsPerOrder')}
          htmlFor="maxTicketsPerOrder"
          error={err('maxTicketsPerOrder')}
          hint={t('unlimitedHint')}
        >
          <Input
            id="maxTicketsPerOrder"
            name="maxTicketsPerOrder"
            type="number"
            min={1}
            max={10000}
            defaultValue={initial.maxTicketsPerOrder ?? ''}
          />
        </Field>
        <Field
          label={t('maxTicketsPerCustomer')}
          htmlFor="maxTicketsPerCustomer"
          error={err('maxTicketsPerCustomer')}
          hint={t('unlimitedHint')}
        >
          <Input
            id="maxTicketsPerCustomer"
            name="maxTicketsPerCustomer"
            type="number"
            min={1}
            max={10000}
            defaultValue={initial.maxTicketsPerCustomer ?? ''}
          />
        </Field>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t('defaults')}</h3>
        <SwitchRow
          name="manualSeatSelectionEnabled"
          defaultChecked={initial.manualSeatSelectionEnabled}
          label={t('manualSeatSelectionEnabled')}
        />
        <SwitchRow
          name="bestAvailableEnabled"
          defaultChecked={initial.bestAvailableEnabled}
          label={t('bestAvailableEnabled')}
        />
        <SwitchRow
          name="orphanSeatRuleEnabled"
          defaultChecked={initial.orphanSeatRuleEnabled}
          label={t('orphanSeatRuleEnabled')}
          hint={t('orphanSeatRuleHint')}
        />
        <SwitchRow
          name="companionSeatsRequireWheelchair"
          defaultChecked={initial.companionSeatsRequireWheelchair}
          label={t('companionSeatsRequireWheelchair')}
          hint={t('companionSeatsRequireWheelchairHint')}
        />
        <SwitchRow
          name="requireTermsAcceptance"
          defaultChecked={initial.requireTermsAcceptance}
          label={t('requireTermsAcceptance')}
          hint={t('requireTermsAcceptanceHint')}
        />
        <SwitchRow
          name="requirePhone"
          defaultChecked={initial.requirePhone}
          label={t('requirePhone')}
          hint={t('requirePhoneHint')}
        />
        <SwitchRow
          name="requireBillingAddress"
          defaultChecked={initial.requireBillingAddress}
          label={t('requireBillingAddress')}
          hint={t('requireBillingAddressHint')}
        />
        <SwitchRow
          name="refundFeesByDefault"
          defaultChecked={initial.refundFeesByDefault}
          label={t('refundFeesByDefault')}
          hint={t('refundFeesByDefaultHint')}
        />
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Seating chart colours ──────────────────────────────────────────────────

export interface SeatDisplayValues {
  inOtherCartColor: string;
  soldColor: string;
  blockedColor: string;
  selectionColor: string;
  selectionStyle: SeatSelectionStyle;
  markUnavailableWithCross: boolean;
  seatChangeCurrentColor: string;
  seatChangeReplacedColor: string;
  seatChangeNewColor: string;
}

export function SeatDisplaySettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: SeatDisplayValues;
}) {
  const t = useTranslations('admin.settings.seatDisplay');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [values, setValues] = useState(initial);
  const set = (key: keyof SeatDisplayValues) => (value: string | boolean) =>
    setValues((v) => ({ ...v, [key]: value }));

  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-4 sm:grid-cols-2">
          <ColorField
            name="inOtherCartColor"
            label={t('inOtherCartColor')}
            value={values.inOtherCartColor}
            onChange={set('inOtherCartColor')}
            error={err('inOtherCartColor')}
          />
          <ColorField
            name="soldColor"
            label={t('soldColor')}
            value={values.soldColor}
            onChange={set('soldColor')}
            error={err('soldColor')}
          />
          <ColorField
            name="blockedColor"
            label={t('blockedColor')}
            value={values.blockedColor}
            onChange={set('blockedColor')}
            error={err('blockedColor')}
          />
          <ColorField
            name="selectionColor"
            label={t('selectionColor')}
            value={values.selectionColor}
            onChange={set('selectionColor')}
            error={err('selectionColor')}
          />
          <Field
            label={t('selectionStyle')}
            htmlFor="selectionStyle"
            error={err('selectionStyle')}
            className="sm:col-span-2"
          >
            <NativeSelect
              id="selectionStyle"
              name="selectionStyle"
              value={values.selectionStyle}
              onChange={(e) => set('selectionStyle')(e.target.value)}
            >
              {SEAT_SELECTION_STYLES.map((style) => (
                <option key={style} value={style}>
                  {t(`selectionStyles.${style}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <ColorField
            name="seatChangeCurrentColor"
            label={t('seatChangeCurrentColor')}
            value={values.seatChangeCurrentColor}
            onChange={set('seatChangeCurrentColor')}
            error={err('seatChangeCurrentColor')}
          />
          <ColorField
            name="seatChangeReplacedColor"
            label={t('seatChangeReplacedColor')}
            value={values.seatChangeReplacedColor}
            onChange={set('seatChangeReplacedColor')}
            error={err('seatChangeReplacedColor')}
          />
          <ColorField
            name="seatChangeNewColor"
            label={t('seatChangeNewColor')}
            value={values.seatChangeNewColor}
            onChange={set('seatChangeNewColor')}
            error={err('seatChangeNewColor')}
          />
          <label className="flex items-center gap-3 text-sm sm:col-span-2">
            <Switch
              name="markUnavailableWithCross"
              checked={values.markUnavailableWithCross}
              onCheckedChange={(checked) => set('markUnavailableWithCross')(checked)}
            />
            {t('markUnavailableWithCross')}
          </label>
        </div>
        <SeatPreview values={values} />
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

/** Example category colour used only for the preview of free / selected seats. */
const PREVIEW_CATEGORY = '#2563EB';

function SeatPreview({ values }: { values: SeatDisplayValues }) {
  const t = useTranslations('admin.settings.seatDisplay.preview');
  const seats: { key: string; fill: string; cross: boolean; ring?: string; label: string }[] = [
    { key: 'free', fill: PREVIEW_CATEGORY, cross: false, label: t('free') },
    { key: 'inCart', fill: values.inOtherCartColor, cross: false, label: t('inOtherCart') },
    {
      key: 'sold',
      fill: values.soldColor,
      cross: values.markUnavailableWithCross,
      label: t('sold'),
    },
    {
      key: 'blocked',
      fill: values.blockedColor,
      cross: values.markUnavailableWithCross,
      label: t('blocked'),
    },
    {
      key: 'selected',
      fill: values.selectionStyle === 'RING' ? PREVIEW_CATEGORY : values.selectionColor,
      cross: false,
      ring: values.selectionStyle === 'FILL' ? undefined : values.selectionColor,
      label: t('selected'),
    },
  ];
  return (
    <figure className="rounded-lg border bg-muted/30 p-4">
      <figcaption className="mb-3 text-xs font-medium text-muted-foreground">
        {t('title')}
      </figcaption>
      <ul className="space-y-2">
        {seats.map((s) => (
          <li key={s.key} className="flex items-center gap-3 text-sm">
            <svg viewBox="-12 -12 24 24" className="size-8" aria-hidden>
              {s.ring && <circle r={10.5} fill="none" stroke={s.ring} strokeWidth={2.5} />}
              <circle r={8} fill={s.fill} />
              {s.cross && (
                <path
                  d="M-4 -4 L4 4 M4 -4 L-4 4"
                  stroke="#52525B"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                />
              )}
            </svg>
            {s.label}
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-4 rounded-xl border bg-card p-5">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
