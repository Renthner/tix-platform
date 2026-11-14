'use client';

import {
  DEFAULT_THEMES,
  LOGO_HEIGHT_MAX,
  LOGO_HEIGHT_MIN,
  LOGO_HEIGHT_SLIDER_MAX,
  LOGO_HEIGHT_SLIDER_MIN,
  SPONSOR_DURATION_DEFAULT,
  SPONSOR_DURATION_MAX,
  SPONSOR_DURATION_MIN,
  SPONSOR_HEIGHT_MAX,
  SPONSOR_HEIGHT_MIN,
  SPONSOR_HEIGHT_SLIDER_MAX,
  SPONSOR_HEIGHT_SLIDER_MIN,
  SPONSOR_MAX_ITEMS,
  SUPPORTED_LOCALES,
  THEME_MODES,
  brandTokens,
  type DefaultTheme,
  type ThemeMode,
} from '@tix/shared';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ActionFeedback,
  ActionForm,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';
import { MediaPicker, type MediaPickerAsset } from './media-picker';
import { RichTextEditor } from './rich-text-editor';
import { ColorField, SwitchRow, useSettingsForm, type Action } from './settings-forms';

// ─── Branding ───────────────────────────────────────────────────────────────

export interface BrandingValues {
  logo: MediaPickerAsset | null;
  favicon: MediaPickerAsset | null;
  logoHeight: number;
  brandColor: string;
  brandColorDark?: string;
  themeMode: ThemeMode;
  defaultTheme: DefaultTheme;
  imprintUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  footerText?: string;
}

/** Slider for the usual range plus a number input that accepts values beyond it (up to `max`). */
export function RangeNumberField({
  name,
  label,
  hint,
  value,
  onChange,
  sliderMin,
  sliderMax,
  min,
  max,
  error,
}: {
  name: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  sliderMin: number;
  sliderMax: number;
  min: number;
  max: number;
  error?: ReturnType<typeof errorOf>;
}) {
  const n = Number(value);
  const sliderValue = Math.min(sliderMax, Math.max(sliderMin, Number.isFinite(n) ? n : sliderMin));
  return (
    <Field label={label} htmlFor={name} error={error} hint={hint}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={1}
          value={sliderValue}
          onChange={(e) => onChange(e.target.value)}
          className="h-2 min-w-0 flex-1 cursor-pointer accent-primary"
          aria-label={label}
        />
        <Input
          id={name}
          name={name}
          type="number"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 shrink-0"
        />
        <span className="text-sm text-muted-foreground">px</span>
      </div>
    </Field>
  );
}

/**
 * Preview surfaces of the two themes (the shop's own tokens are neutral: white / near-black), so
 * the preview shows exactly what the brand colour does on them.
 */
const PREVIEW_SURFACES = {
  light: { page: '#ffffff', card: '#ffffff', text: '#0a0a0a', muted: '#737373', border: '#e5e5e5' },
  dark: { page: '#0a0a0a', card: '#171717', text: '#fafafa', muted: '#a3a3a3', border: '#2e2e2e' },
} as const;

/** Mini shop card in the light and the dark theme with the brand colour applied (live). */
function BrandPreview({
  brand,
  darkOverride,
  shopName,
}: {
  brand: string;
  darkOverride: string;
  shopName: string;
}) {
  const t = useTranslations('admin.settings.branding');
  const tokens = brandTokens(brand, darkOverride);
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="brand-preview">
      {(['light', 'dark'] as const).map((mode) => {
        const c = PREVIEW_SURFACES[mode];
        const theme = tokens[mode];
        return (
          <div
            key={mode}
            data-testid={`brand-preview-${mode}`}
            className="overflow-hidden rounded-lg border"
            style={{ background: c.page, color: c.text, borderColor: c.border }}
          >
            <div
              className="flex items-center justify-between gap-2 border-b px-3 py-2"
              style={{ borderColor: c.border }}
            >
              <span className="truncate font-semibold" style={{ color: theme.primary }}>
                {shopName}
              </span>
              <span className="shrink-0 text-xs" style={{ color: c.muted }}>
                {t(mode === 'light' ? 'previewLight' : 'previewDark')}
              </span>
            </div>
            <div className="space-y-3 p-3 text-sm" style={{ background: c.card }}>
              <p style={{ color: c.muted }}>{t('previewText')}</p>
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className="rounded-md px-3 py-1.5 text-sm font-medium"
                  style={{ background: theme.primary, color: theme.foreground }}
                >
                  {t('previewButton')}
                </span>
                <span className="underline underline-offset-2" style={{ color: theme.primary }}>
                  {t('previewLink')}
                </span>
                <span
                  className="rounded-full border px-2 py-0.5 text-xs"
                  style={{ borderColor: theme.primary, color: theme.primary }}
                >
                  {t('previewBadge')}
                </span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full"
                style={{ background: c.border }}
                aria-hidden
              >
                <div className="h-full w-2/3" style={{ background: theme.primary }} />
              </div>
              <p className="text-xs" style={{ color: c.muted }}>
                {t('previewContrast', { ratio: theme.textContrast.toFixed(1) })}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BrandingSettingsForm({
  action,
  initial,
  shopName,
}: {
  action: Action;
  initial: BrandingValues;
  shopName: string;
}) {
  const t = useTranslations('admin.settings.branding');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [brand, setBrand] = useState(initial.brandColor);
  const [dark, setDark] = useState(initial.brandColorDark ?? '');
  const [logoHeight, setLogoHeight] = useState(String(initial.logoHeight));
  const [themeMode, setThemeMode] = useState<ThemeMode>(initial.themeMode);
  const validBrand = /^#[0-9a-f]{6}$/i.test(brand);
  const validDark = /^#[0-9a-f]{6}$/i.test(dark);
  const tokens = brandTokens(validBrand ? brand : '#111827', validDark ? dark : null);
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
        <RangeNumberField
          name="logoHeight"
          label={t('logoHeight')}
          hint={t('logoHeightHint', { min: LOGO_HEIGHT_MIN, max: LOGO_HEIGHT_MAX })}
          value={logoHeight}
          onChange={setLogoHeight}
          sliderMin={LOGO_HEIGHT_SLIDER_MIN}
          sliderMax={LOGO_HEIGHT_SLIDER_MAX}
          min={LOGO_HEIGHT_MIN}
          max={LOGO_HEIGHT_MAX}
          error={err('logoHeight')}
        />
        <div className="hidden md:block" />
        <div className="space-y-4 md:col-span-2">
          <div className="grid gap-4 md:grid-cols-2">
            <ColorField
              name="brandColor"
              label={t('brandColor')}
              value={brand}
              onChange={setBrand}
              error={err('brandColor')}
            />
            <div className="space-y-1.5">
              <ColorField
                name="brandColorDark"
                label={t('brandColorDark')}
                value={dark}
                onChange={setDark}
                error={err('brandColorDark')}
              />
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {validDark
                    ? t('brandColorDarkCustom')
                    : t('brandColorDarkComputed', { color: tokens.dark.primary })}
                </span>
                {dark && (
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => setDark('')}
                  >
                    {t('brandColorDarkClear')}
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('brandColorHint')}</p>
          {validBrand && !tokens.lightTextOk && (
            <Alert variant="destructive" data-testid="brand-contrast-warning">
              <AlertDescription>
                {t('brandContrastWarning', { ratio: tokens.light.textContrast.toFixed(1) })}
              </AlertDescription>
            </Alert>
          )}
          <BrandPreview
            brand={validBrand ? brand : '#111827'}
            darkOverride={validDark ? dark : ''}
            shopName={shopName}
          />
        </div>
        <Field
          label={t('themeMode')}
          htmlFor="themeMode"
          error={err('themeMode')}
          hint={t('themeModeHint')}
        >
          <NativeSelect
            id="themeMode"
            name="themeMode"
            value={themeMode}
            onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
          >
            {THEME_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`themeModes.${m}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label={t('defaultTheme')}
          htmlFor="defaultTheme"
          error={err('defaultTheme')}
          hint={t('defaultThemeHint')}
        >
          <NativeSelect id="defaultTheme" name="defaultTheme" defaultValue={initial.defaultTheme}>
            {DEFAULT_THEMES.map((m) => (
              <option key={m} value={m}>
                {t(`defaultThemes.${m}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
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

// ─── Sponsors ───────────────────────────────────────────────────────────────

export interface SponsorRowValues {
  key: string;
  asset: MediaPickerAsset | null;
  durationSeconds: string;
  url: string;
  alt: Record<string, string>;
}

export interface SponsorsValues {
  enabled: boolean;
  height: number;
  label: Record<string, string>;
  items: SponsorRowValues[];
  defaultLocale: string;
}

let sponsorKeySeed = 0;

export function SponsorsSettingsForm({
  action,
  initial,
}: {
  action: Action;
  initial: SponsorsValues;
}) {
  const t = useTranslations('admin.settings.sponsors');
  const tc = useTranslations('common.actions');
  const tl = useTranslations('common.locale');
  const { state, formAction, err } = useSettingsForm(action);
  const [height, setHeight] = useState(String(initial.height));
  const [rows, setRows] = useState<SponsorRowValues[]>(initial.items);
  const patch = (index: number, change: Partial<SponsorRowValues>) =>
    setRows((list) => list.map((r, i) => (i === index ? { ...r, ...change } : r)));
  const move = (index: number, delta: number) =>
    setRows((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  return (
    <ActionForm action={formAction} className="space-y-4">
      <ActionFeedback state={state} />
      <SwitchRow
        name="enabled"
        defaultChecked={initial.enabled}
        label={t('enabled')}
        hint={t('enabledHint')}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <RangeNumberField
          name="height"
          label={t('height')}
          hint={t('heightHint', { min: SPONSOR_HEIGHT_MIN, max: SPONSOR_HEIGHT_MAX })}
          value={height}
          onChange={setHeight}
          sliderMin={SPONSOR_HEIGHT_SLIDER_MIN}
          sliderMax={SPONSOR_HEIGHT_SLIDER_MAX}
          min={SPONSOR_HEIGHT_MIN}
          max={SPONSOR_HEIGHT_MAX}
          error={err('height')}
        />
        <div className="space-y-2">
          {SUPPORTED_LOCALES.map((loc) => (
            <Field
              key={loc}
              label={`${t('label')} (${tl(loc)})`}
              htmlFor={`label.${loc}`}
              error={err(`label.${loc}`)}
              hint={loc === initial.defaultLocale ? t('labelHint') : undefined}
            >
              <Input
                id={`label.${loc}`}
                name={`label.${loc}`}
                defaultValue={initial.label[loc] ?? ''}
                maxLength={60}
              />
            </Field>
          ))}
        </div>
      </div>
      <input type="hidden" name="itemCount" value={rows.length} />
      <ol className="space-y-3" data-testid="sponsor-rows">
        {rows.map((row, i) => (
          <li key={row.key} className="space-y-3 rounded-lg border p-4" data-testid="sponsor-row">
            <input type="hidden" name={`item.${i}.id`} value={row.key} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{t('sponsorN', { n: i + 1 })}</span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={t('moveUp')}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => move(i, 1)}
                  disabled={i === rows.length - 1}
                  aria-label={t('moveDown')}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRows((list) => list.filter((_, idx) => idx !== i))}
                  aria-label={t('remove')}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label={t('image')}
                htmlFor={`item.${i}.assetId`}
                error={err(`item.${i}.assetId`)}
              >
                <MediaPicker
                  name={`item.${i}.assetId`}
                  kind="LOGO"
                  visibility="public"
                  initialAsset={row.asset}
                  previewClassName="max-w-xs"
                  previewAlt={t('image')}
                  onChange={(asset) => patch(i, { asset })}
                />
              </Field>
              <div className="space-y-3">
                <Field
                  label={t('url')}
                  htmlFor={`item.${i}.url`}
                  error={err(`item.${i}.url`)}
                  hint={t('urlHint')}
                >
                  <Input
                    id={`item.${i}.url`}
                    name={`item.${i}.url`}
                    value={row.url}
                    onChange={(e) => patch(i, { url: e.target.value })}
                    placeholder="https://"
                  />
                </Field>
                <Field
                  label={t('duration')}
                  htmlFor={`item.${i}.duration`}
                  error={err(`item.${i}.durationSeconds`)}
                  hint={t('durationHint', {
                    min: SPONSOR_DURATION_MIN,
                    max: SPONSOR_DURATION_MAX,
                  })}
                >
                  <Input
                    id={`item.${i}.duration`}
                    name={`item.${i}.duration`}
                    type="number"
                    min={SPONSOR_DURATION_MIN}
                    max={SPONSOR_DURATION_MAX}
                    value={row.durationSeconds}
                    onChange={(e) => patch(i, { durationSeconds: e.target.value })}
                    className="w-28"
                  />
                </Field>
              </div>
              {SUPPORTED_LOCALES.map((loc) => (
                <Field
                  key={loc}
                  label={`${t('alt')} (${tl(loc)})`}
                  htmlFor={`item.${i}.alt.${loc}`}
                  error={err(`item.${i}.alt.${loc}`)}
                  hint={loc === initial.defaultLocale ? t('altHint') : undefined}
                >
                  <Input
                    id={`item.${i}.alt.${loc}`}
                    name={`item.${i}.alt.${loc}`}
                    value={row.alt[loc] ?? ''}
                    onChange={(e) => patch(i, { alt: { ...row.alt, [loc]: e.target.value } })}
                    maxLength={200}
                  />
                </Field>
              ))}
            </div>
          </li>
        ))}
      </ol>
      {rows.length < SPONSOR_MAX_ITEMS && (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setRows((list) => [
              ...list,
              {
                key: `n${Date.now().toString(36)}${sponsorKeySeed++}`,
                asset: null,
                durationSeconds: String(SPONSOR_DURATION_DEFAULT),
                url: '',
                alt: {},
              },
            ])
          }
        >
          <Plus className="size-4" /> {t('add')}
        </Button>
      )}
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
