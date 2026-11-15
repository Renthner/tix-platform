'use client';

import type { TicketLayout } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { MediaPicker, type MediaPickerAsset } from '@/components/admin/media-picker';
import { Textarea } from '@/components/ui/textarea';
import type { ElementPatch } from '../canvas';
import { ColorField, NumberField, PanelGroup, Select } from './fields';
import { PRESETS } from './model';
import type { Draft } from './types';

export function PageProps({
  draft,
  presetValue,
  canMatchCover,
  onPreset,
  onSize,
  onBackground,
  onDescription,
}: {
  draft: Draft;
  presetValue: string;
  canMatchCover: boolean;
  onPreset: (key: string) => void;
  onSize: (w: number, h: number) => void;
  onBackground: (asset: MediaPickerAsset | null) => void;
  onDescription: (value: string) => void;
}) {
  const t = useTranslations('ticketDesigner');
  const options = [
    ...PRESETS.map((p) => ({
      value: p.key as string,
      label: t(`presets.${p.key}`, { w: p.width, h: p.height }),
    })),
    ...(canMatchCover ? [{ value: 'cover', label: t('presets.cover') }] : []),
    { value: 'custom', label: t('presets.custom') },
  ];
  return (
    <>
      <PanelGroup title={t('props.pageSize')}>
        <Select
          label={t('presets.label')}
          value={presetValue}
          options={options}
          onChange={onPreset}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('props.width')}
            value={draft.pageWidthMm}
            min={20}
            max={2000}
            onChange={(v) => onSize(v, draft.pageHeightMm)}
          />
          <NumberField
            label={t('props.height')}
            value={draft.pageHeightMm}
            min={20}
            max={2000}
            onChange={(v) => onSize(draft.pageWidthMm, v)}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('props.sizeHint')}</p>
      </PanelGroup>
      <PanelGroup title={t('props.background')}>
        <MediaPicker
          name="backgroundAssetId"
          kind="TICKET_BACKGROUND"
          visibility="private"
          initialAsset={draft.background}
          aspectRatio={draft.pageWidthMm / draft.pageHeightMm}
          previewClassName="max-w-full"
          fit="cover"
          onChange={onBackground}
        />
        <p className="text-xs text-muted-foreground">{t('props.backgroundHint')}</p>
      </PanelGroup>
      <PanelGroup title={t('props.description')}>
        <Textarea
          rows={2}
          maxLength={500}
          defaultValue={draft.description ?? ''}
          onChange={(e) => onDescription(e.target.value)}
        />
      </PanelGroup>
      <p className="text-xs text-muted-foreground">
        {t('props.placeholders', { example: '{{eventTitle}}' })}
      </p>
    </>
  );
}

export function QrProps({
  qr,
  onChange,
}: {
  qr: TicketLayout['qr'];
  onChange: (patch: ElementPatch) => void;
}) {
  const t = useTranslations('ticketDesigner.props');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="X (mm)" value={qr.x} min={0} onChange={(x) => onChange({ x })} />
        <NumberField label="Y (mm)" value={qr.y} min={0} onChange={(y) => onChange({ y })} />
        <NumberField
          label={t('size')}
          value={qr.size}
          min={10}
          max={300}
          onChange={(size) => onChange({ size })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          label={t('errorCorrection')}
          value={qr.errorCorrection}
          options={(['L', 'M', 'Q', 'H'] as const).map((v) => ({ value: v, label: v }))}
          onChange={(errorCorrection) => onChange({ errorCorrection })}
        />
        <NumberField
          label={t('margin')}
          value={qr.margin}
          min={0}
          max={10}
          step={1}
          onChange={(margin) => onChange({ margin: Math.round(margin) })}
        />
        <ColorField
          label={t('foreground')}
          value={qr.foreground}
          onChange={(v) => v && onChange({ foreground: v })}
        />
        <ColorField
          label={t('qrBackground')}
          value={qr.background}
          onChange={(v) => v && onChange({ background: v })}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('qrHint')}</p>
    </div>
  );
}
