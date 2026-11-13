'use client';

import {
  SEAT_SELECTION_STYLES,
  START_PAGE_LAYOUTS,
  START_PAGE_HTML_MAX,
  START_PAGE_MAX_GALLERY,
  START_PAGE_MODES,
  START_PAGE_BUTTON_ALIGNS,
  SHOP_EVENTS_PER_ROW_MAX,
  SUPPORTED_LOCALES,
  type SeatSelectionStyle,
  type StartPageLayout,
  type StartPageMode,
  type StartPageButtonAlign,
} from '@tix/shared';
import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { IDLE, type ActionState, type FieldErrorCode } from '@/lib/action-state';
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

export function ColorField({
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
            visibility="public"
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
            visibility="public"
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

// ─── Shop event list layout ─────────────────────────────────────────────────

export function ShopLayoutSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: { eventsPerRow: number };
}) {
  const t = useTranslations('admin.settings.shopLayout');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [perRow, setPerRow] = useState(Math.min(initial.eventsPerRow, SHOP_EVENTS_PER_ROW_MAX));
  return (
    <ActionForm action={formAction} className="space-y-6">
      <ActionFeedback state={state} />
      <Field
        label={t('eventsPerRow')}
        htmlFor="eventsPerRow"
        error={err('eventsPerRow')}
        hint={t('eventsPerRowHint')}
      >
        <div className="flex items-center gap-4">
          <input
            id="eventsPerRow"
            name="eventsPerRow"
            type="range"
            min={1}
            max={SHOP_EVENTS_PER_ROW_MAX}
            step={1}
            value={perRow}
            onChange={(e) => setPerRow(Number(e.target.value))}
            className="w-full max-w-xs"
          />
          <Input
            type="number"
            min={1}
            max={SHOP_EVENTS_PER_ROW_MAX}
            value={perRow}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) setPerRow(Math.min(SHOP_EVENTS_PER_ROW_MAX, Math.max(1, n)));
            }}
            aria-label={t('eventsPerRow')}
            className="w-20"
          />
        </div>
      </Field>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Start page without events ──────────────────────────────────────────────

export interface StartPageValues {
  mode: StartPageMode;
  layout: StartPageLayout;
  hero: MediaPickerAsset | null;
  gallery: (MediaPickerAsset | null)[];
  buttonUrl?: string;
  buttonAlign: StartPageButtonAlign;
  /** Shop default language: preselected content language. */
  defaultLocale: string;
  texts: Partial<
    Record<
      string,
      {
        headline?: string;
        subheadline?: string;
        body?: string;
        buttonLabel?: string;
        heroAlt?: string;
        galleryAlt?: string[];
        html?: string;
      }
    >
  >;
}

/** Code field for one locale; the picked image is inserted at the cursor as an <img> tag. */
function StartPageHtmlField({
  loc,
  defaultValue,
  error,
}: {
  loc: string;
  defaultValue: string;
  error?: FieldErrorCode;
}) {
  const t = useTranslations('admin.settings.startPage');
  const area = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="space-y-3">
      <Field label={t('html')} htmlFor={`html.${loc}`} error={error}>
        <Textarea
          id={`html.${loc}`}
          name={`html.${loc}`}
          ref={area}
          rows={20}
          spellCheck={false}
          defaultValue={defaultValue}
          className="field-sizing-fixed min-h-80 font-mono text-xs"
        />
      </Field>
      <Field label={t('htmlInsertImage')} htmlFor={`htmlImage.${loc}`}>
        <MediaPicker
          name={`htmlImage.${loc}`}
          kind="EVENT_IMAGE"
          previewClassName="max-w-[10rem]"
          onChange={(a) => {
            const el = area.current;
            if (!a || !el) return;
            el.setRangeText(
              `<img src="/api/media/${a.id}" alt="">`,
              el.selectionStart,
              el.selectionEnd,
              'end',
            );
            el.focus();
          }}
        />
      </Field>
    </div>
  );
}

export function StartPageSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: StartPageValues;
}) {
  const t = useTranslations('admin.settings.startPage');
  const tl = useTranslations('common.locale');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const slots = Array.from(
    { length: START_PAGE_MAX_GALLERY },
    (_, i) => initial.gallery[i] ?? null,
  );
  // Alt-text inputs follow the slots that currently hold an image (also right after an upload).
  const [filled, setFilled] = useState(slots.map((a) => !!a));
  // Both variants stay in the form (hidden, not removed) so switching never discards data.
  const [mode, setMode] = useState<StartPageMode>(initial.mode);
  const builder = mode === 'BUILDER';
  // One content language is shown at a time; all languages stay mounted (hidden) and submitted.
  const tsw = useTranslations('translations.switcher');
  const [current, setCurrent] = useState<string>(
    (SUPPORTED_LOCALES as readonly string[]).includes(initial.defaultLocale)
      ? initial.defaultLocale
      : SUPPORTED_LOCALES[0],
  );
  // A validation error in a hidden language switches the dropdown to that language.
  const [seenAt, setSeenAt] = useState(0);
  if (state.status === 'error' && state.at !== seenAt) {
    setSeenAt(state.at);
    const withError = SUPPORTED_LOCALES.find((loc) =>
      Object.keys(state.fieldErrors ?? {}).some((k) => k.endsWith(`.${loc}`)),
    );
    if (withError && withError !== current) setCurrent(withError);
  }
  const localeSwitcher = (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{tsw('label')}</span>
      <NativeSelect
        aria-label={tsw('label')}
        value={current}
        className="h-9 w-auto min-w-44"
        onChange={(e) => setCurrent(e.target.value)}
      >
        {SUPPORTED_LOCALES.map((loc) => (
          <option key={loc} value={loc}>
            {tl(loc)}
            {loc === initial.defaultLocale ? ` ${tsw('default')}` : ''}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
  return (
    <ActionForm action={formAction} className="space-y-6">
      <ActionFeedback state={state} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('mode')}</legend>
        <div className="flex flex-wrap gap-4">
          {START_PAGE_MODES.map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              {t(`modes.${m}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className={builder ? 'hidden' : 'space-y-4'}>
        <p className="text-sm text-muted-foreground">
          {t('htmlHint', { max: Math.round(START_PAGE_HTML_MAX / 1000) })}
        </p>
        {localeSwitcher}
        {SUPPORTED_LOCALES.map((loc) => (
          <fieldset
            key={loc}
            className={loc === current ? 'space-y-4 rounded-lg border p-4' : 'hidden'}
          >
            <legend className="px-1 text-sm font-semibold">{tl(loc)}</legend>
            <StartPageHtmlField
              loc={loc}
              defaultValue={initial.texts[loc]?.html ?? ''}
              error={err(`html.${loc}`)}
            />
          </fieldset>
        ))}
      </div>
      <div className={builder ? 'space-y-6' : 'hidden'}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('layout')} htmlFor="layout" error={err('layout')} hint={t('layoutHint')}>
            <NativeSelect id="layout" name="layout" defaultValue={initial.layout}>
              {START_PAGE_LAYOUTS.map((l) => (
                <option key={l} value={l}>
                  {t(`layouts.${l}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            label={t('buttonUrl')}
            htmlFor="buttonUrl"
            error={err('buttonUrl')}
            hint={t('buttonUrlHint')}
          >
            <Input
              id="buttonUrl"
              name="buttonUrl"
              defaultValue={initial.buttonUrl ?? ''}
              placeholder="https://"
              maxLength={500}
            />
          </Field>
          <Field label={t('buttonAlign')} htmlFor="buttonAlign" error={err('buttonAlign')}>
            <NativeSelect id="buttonAlign" name="buttonAlign" defaultValue={initial.buttonAlign}>
              {START_PAGE_BUTTON_ALIGNS.map((a) => (
                <option key={a} value={a}>
                  {t(`buttonAligns.${a}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {localeSwitcher}
        {SUPPORTED_LOCALES.map((loc) => {
          const v = initial.texts[loc] ?? {};
          return (
            <fieldset
              key={loc}
              className={loc === current ? 'space-y-4 rounded-lg border p-4' : 'hidden'}
            >
              <legend className="px-1 text-sm font-semibold">{tl(loc)}</legend>
              <div className="grid gap-4 md:grid-cols-2">
                <Field
                  label={t('headline')}
                  htmlFor={`headline.${loc}`}
                  error={err(`headline.${loc}`)}
                >
                  <Input
                    id={`headline.${loc}`}
                    name={`headline.${loc}`}
                    defaultValue={v.headline ?? ''}
                    maxLength={200}
                  />
                </Field>
                <Field
                  label={t('subheadline')}
                  htmlFor={`subheadline.${loc}`}
                  error={err(`subheadline.${loc}`)}
                >
                  <Input
                    id={`subheadline.${loc}`}
                    name={`subheadline.${loc}`}
                    defaultValue={v.subheadline ?? ''}
                    maxLength={400}
                  />
                </Field>
                <Field
                  label={t('buttonLabel')}
                  htmlFor={`buttonLabel.${loc}`}
                  error={err(`buttonLabel.${loc}`)}
                >
                  <Input
                    id={`buttonLabel.${loc}`}
                    name={`buttonLabel.${loc}`}
                    defaultValue={v.buttonLabel ?? ''}
                    maxLength={80}
                  />
                </Field>
                <Field
                  label={t('heroAlt')}
                  htmlFor={`heroAlt.${loc}`}
                  error={err(`heroAlt.${loc}`)}
                >
                  <Input
                    id={`heroAlt.${loc}`}
                    name={`heroAlt.${loc}`}
                    defaultValue={v.heroAlt ?? ''}
                    maxLength={200}
                  />
                </Field>
                <Field
                  label={t('body')}
                  htmlFor={`body.${loc}`}
                  error={err(`body.${loc}`)}
                  className="md:col-span-2"
                >
                  <RichTextEditor
                    id={`body.${loc}`}
                    name={`body.${loc}`}
                    compact
                    defaultValue={v.body ?? ''}
                    invalid={!!err(`body.${loc}`)}
                  />
                </Field>
                {slots.map((_, i) =>
                  filled[i] ? (
                    <Field
                      key={i}
                      label={t('galleryAlt', { n: i + 1 })}
                      htmlFor={`galleryAlt${i}.${loc}`}
                      error={err(`galleryAlt${i}.${loc}`)}
                    >
                      <Input
                        id={`galleryAlt${i}.${loc}`}
                        name={`galleryAlt${i}.${loc}`}
                        defaultValue={v.galleryAlt?.[i] ?? ''}
                        maxLength={200}
                      />
                    </Field>
                  ) : null,
                )}
              </div>
            </fieldset>
          );
        })}
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label={t('hero')}
            htmlFor="heroAssetId"
            error={err('heroAssetId')}
            hint={t('heroHint')}
            className="md:col-span-2"
          >
            <MediaPicker
              name="heroAssetId"
              kind="EVENT_IMAGE"
              initialAsset={initial.hero}
              previewClassName="max-w-md"
              previewAlt={t('hero')}
            />
          </Field>
          {slots.map((asset, i) => (
            <Field
              key={i}
              label={t('galleryImage', { n: i + 1 })}
              htmlFor={`galleryAssetId${i}`}
              error={err(`galleryAssetId${i}`)}
              hint={i === 0 ? t('galleryHint', { max: START_PAGE_MAX_GALLERY }) : undefined}
            >
              <MediaPicker
                name={`galleryAssetId${i}`}
                kind="EVENT_IMAGE"
                initialAsset={asset}
                onChange={(a) => setFilled((f) => f.map((x, j) => (j === i ? !!a : x)))}
                previewClassName="max-w-xs"
                previewAlt={t('galleryImage', { n: i + 1 })}
              />
            </Field>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('altHint')}</p>
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}
