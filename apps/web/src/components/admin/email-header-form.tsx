'use client';

import {
  EMAIL_HEADER_ALIGNS,
  EMAIL_HEADER_CHIP_CORNERS,
  EMAIL_HEADER_CHIP_PADDINGS,
  EMAIL_HEADER_HEX_PATTERN,
  EMAIL_HEADER_LAYOUTS,
  EMAIL_HEADER_LOGO_DISPLAYS,
  EMAIL_HEADER_LOGO_HEIGHT_MAX,
  EMAIL_HEADER_LOGO_HEIGHT_MIN,
  emailLogoSize,
  foregroundOn,
  renderShopHeaderHtml,
  type EmailHeaderAlign,
  type EmailHeaderChipCorners,
  type EmailHeaderChipPadding,
  type EmailHeaderLayout,
  type EmailHeaderLogoDisplay,
} from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { ActionFeedback, ActionForm, Field, NativeSelect, SubmitButton } from './form-controls';
import { MediaPicker, type MediaPickerAsset } from './media-picker';
import { ColorField, useSettingsForm, type Action } from './settings-forms';

export interface EmailHeaderValues {
  logoDisplay: EmailHeaderLogoDisplay;
  layout: EmailHeaderLayout;
  align: EmailHeaderAlign;
  logoHeight: number | null;
  chipColor: string;
  chipCorners: EmailHeaderChipCorners;
  chipPadding: EmailHeaderChipPadding;
  /** Dedicated e-mail logo (media library asset), if any. */
  override: MediaPickerAsset | null;
}

/** The shop logo as the mail would use it; `supported` = PNG/JPEG (otherwise mails omit it). */
export interface EmailHeaderShopLogo {
  id: string;
  width: number | null;
  height: number | null;
  supported: boolean;
  /** Logo height of the shop header (px), the fallback of the automatic e-mail height. */
  shopHeaderHeight: number;
}

/** Live preview: the same builder as the mail renderer, shown in a sandboxed frame. */
function HeaderPreview({ html, brand, title }: { html: string; brand: string; title: string }) {
  const doc =
    `<!doctype html><html><body style="margin:0;padding:16px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="background:${brand};border-radius:8px 8px 0 0;padding:20px 28px;font-size:20px;font-weight:700">${html}</td>` +
    `</tr></table></body></html>`;
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={doc}
      className="h-40 w-full rounded-md border bg-paper"
      data-testid="email-header-preview"
    />
  );
}

export function EmailHeaderSettingsForm({
  action,
  initial,
  shopName,
  brandColor,
  shopLogo,
}: {
  action: Action;
  initial: EmailHeaderValues;
  shopName: string;
  brandColor: string;
  shopLogo: EmailHeaderShopLogo | null;
}) {
  const t = useTranslations('admin.settings.emailHeader');
  const tc = useTranslations('common.actions');
  const { state, formAction, err } = useSettingsForm(action);
  const [logoDisplay, setLogoDisplay] = useState(initial.logoDisplay);
  const [layout, setLayout] = useState(initial.layout);
  const [align, setAlign] = useState(initial.align);
  const [logoHeight, setLogoHeight] = useState(
    initial.logoHeight === null ? '' : String(initial.logoHeight),
  );
  const [chipColor, setChipColor] = useState(initial.chipColor);
  const [chipCorners, setChipCorners] = useState(initial.chipCorners);
  const [chipPadding, setChipPadding] = useState(initial.chipPadding);
  const [override, setOverride] = useState<MediaPickerAsset | null>(initial.override);

  // The logo the mail would use: the dedicated one, else the shop logo (PNG/JPEG only).
  const source = override
    ? { id: override.id, width: override.width, height: override.height }
    : shopLogo?.supported
      ? shopLogo
      : null;
  const heightNumber = logoHeight.trim() === '' ? null : Number(logoHeight);
  const explicitHeight =
    heightNumber !== null && Number.isInteger(heightNumber) ? heightNumber : null;
  const previewLogo = source
    ? {
        url: `/api/media/${source.id}`,
        ...emailLogoSize(
          shopLogo?.shopHeaderHeight ?? 36,
          { width: source.width, height: source.height },
          explicitHeight,
        ),
      }
    : null;
  const brand = EMAIL_HEADER_HEX_PATTERN.test(brandColor) ? brandColor : '#111827';
  const foreground = foregroundOn(brand);
  const html = renderShopHeaderHtml({
    shopName,
    foreground,
    logo: previewLogo,
    options: {
      logoDisplay,
      layout,
      align,
      chipColor: EMAIL_HEADER_HEX_PATTERN.test(chipColor) ? chipColor : '#ffffff',
      chipCorners,
      chipPadding,
    },
  });
  const showsLogo = logoDisplay !== 'NONE' && layout !== 'TITLE_ONLY';
  const chip = logoDisplay === 'CHIP' && showsLogo;

  return (
    <ActionForm action={formAction} unsavedGuard={state} className="space-y-5">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('logoDisplay')} htmlFor="logoDisplay" error={err('logoDisplay')}>
          <NativeSelect
            id="logoDisplay"
            name="logoDisplay"
            value={logoDisplay}
            onChange={(e) => setLogoDisplay(e.target.value as EmailHeaderLogoDisplay)}
          >
            {EMAIL_HEADER_LOGO_DISPLAYS.map((v) => (
              <option key={v} value={v}>
                {t(`logoDisplays.${v}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('layout')} htmlFor="layout" error={err('layout')}>
          <NativeSelect
            id="layout"
            name="layout"
            value={layout}
            onChange={(e) => setLayout(e.target.value as EmailHeaderLayout)}
          >
            {EMAIL_HEADER_LAYOUTS.map((v) => (
              <option key={v} value={v}>
                {t(`layouts.${v}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('align')} htmlFor="align" error={err('align')} hint={t('alignHint')}>
          <NativeSelect
            id="align"
            name="align"
            value={align}
            onChange={(e) => setAlign(e.target.value as EmailHeaderAlign)}
          >
            {EMAIL_HEADER_ALIGNS.map((v) => (
              <option key={v} value={v}>
                {t(`aligns.${v}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label={t('logoHeight')}
          htmlFor="logoHeight"
          error={err('logoHeight')}
          hint={t('logoHeightHint', {
            min: EMAIL_HEADER_LOGO_HEIGHT_MIN,
            max: EMAIL_HEADER_LOGO_HEIGHT_MAX,
          })}
        >
          <Input
            id="logoHeight"
            name="logoHeight"
            type="number"
            min={EMAIL_HEADER_LOGO_HEIGHT_MIN}
            max={EMAIL_HEADER_LOGO_HEIGHT_MAX}
            step={1}
            value={logoHeight}
            onChange={(e) => setLogoHeight(e.target.value)}
            className="w-32"
          />
        </Field>
      </div>
      {layout === 'LOGO_ONLY' && (
        <p className="text-xs text-muted-foreground">{t('layoutLogoOnlyHint')}</p>
      )}

      {/* The chip fields stay in the form (hidden) so their values are always submitted. */}
      <div className={chip ? 'grid gap-4 md:grid-cols-3' : 'hidden'}>
        <ColorField
          name="chipColor"
          label={t('chipColor')}
          value={chipColor}
          onChange={setChipColor}
          error={err('chipColor')}
        />
        <Field label={t('chipCorners')} htmlFor="chipCorners" error={err('chipCorners')}>
          <NativeSelect
            id="chipCorners"
            name="chipCorners"
            value={chipCorners}
            onChange={(e) => setChipCorners(e.target.value as EmailHeaderChipCorners)}
          >
            {EMAIL_HEADER_CHIP_CORNERS.map((v) => (
              <option key={v} value={v}>
                {t(`corners.${v}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('chipPadding')} htmlFor="chipPadding" error={err('chipPadding')}>
          <NativeSelect
            id="chipPadding"
            name="chipPadding"
            value={chipPadding}
            onChange={(e) => setChipPadding(e.target.value as EmailHeaderChipPadding)}
          >
            {EMAIL_HEADER_CHIP_PADDINGS.map((v) => (
              <option key={v} value={v}>
                {t(`paddings.${v}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <Field
        label={t('logoOverride')}
        htmlFor="logoAssetId"
        error={err('logoAssetId')}
        hint={t('logoOverrideHint')}
      >
        <MediaPicker
          name="logoAssetId"
          kind="EMAIL_IMAGE"
          visibility="public"
          initialAsset={initial.override}
          onChange={setOverride}
          previewClassName="max-w-xs"
          previewAlt={t('logoOverride')}
        />
      </Field>

      {logoDisplay === 'DIRECT' && showsLogo && (
        <Alert data-testid="email-header-contrast-hint">
          <AlertDescription>{t('contrastHint')}</AlertDescription>
        </Alert>
      )}
      {showsLogo && !source && <p className="text-xs text-muted-foreground">{t('noLogo')}</p>}

      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t('preview')}</p>
        <HeaderPreview html={html} brand={brand} title={t('previewTitle')} />
      </div>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}
