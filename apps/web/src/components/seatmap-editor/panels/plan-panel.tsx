'use client';

import {
  SPECIAL_SEAT_ICONS,
  SPECIAL_SEAT_LABEL_MODES,
  type SpecialSeatLabel,
  type SpecialSeatLabelMode,
} from '@tix/shared';
import { useTranslations } from 'next-intl';
import { PlanCategoriesSection } from '../plan-categories';
import { NumberField, PanelSection, SelectField, SwitchField, TextField } from '../fields';
import { COLORS, type Doc } from '../model';
import { SymbolPicker } from '../symbol-picker';
import { type PanelProps } from './types';

/** Plan label of wheelchair spaces or companion seats (icon, number, short text, nothing). */
function SpecialSeatLabelField({
  kind,
  value,
  onChange,
}: {
  kind: 'wheelchair' | 'companion';
  value: SpecialSeatLabel | undefined;
  onChange: (value: SpecialSeatLabel) => void;
}) {
  const t = useTranslations('editor');
  const mode = value?.mode ?? 'ICON';
  const icon = SPECIAL_SEAT_ICONS[kind];
  return (
    <div className="grid grid-cols-[1fr_auto] items-end gap-2">
      <SelectField
        label={t(`fields.${kind}Label`)}
        value={mode}
        options={SPECIAL_SEAT_LABEL_MODES.map((m) => ({
          value: m,
          label: t(`options.specialSeatLabel.${m}`, { icon }),
        }))}
        onChange={(m) =>
          m &&
          onChange({
            mode: m as SpecialSeatLabelMode,
            ...(m === 'TEXT' ? { text: value?.text || (kind === 'wheelchair' ? 'R' : 'B') } : {}),
          })
        }
      />
      {mode === 'TEXT' ? (
        <div className="w-16">
          <TextField
            label={t('fields.shortText')}
            value={value?.text ?? ''}
            maxLength={3}
            onChange={(text) => onChange({ mode: 'TEXT', text })}
          />
        </div>
      ) : (
        <span className="w-16" />
      )}
    </div>
  );
}

export function PlanPanel({ doc, apply, symbols, planCategories }: PanelProps) {
  const t = useTranslations('editor');
  const s = doc.settings;
  const setSettings = (patch: Partial<Doc['settings']>, key: string) =>
    apply((d) => ({ ...d, settings: { ...d.settings, ...patch } }), `plan:${key}`);
  return (
    <>
      <PanelSection title={t('panel.plan')}>
        <TextField
          label={t('fields.name')}
          value={doc.name}
          maxLength={120}
          onChange={(name) => apply((d) => (d.name === name ? d : { ...d, name }), 'plan:name')}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('fields.canvasWidth')}
            value={doc.canvasWidth}
            integer
            min={100}
            max={100_000}
            onChange={(v) => v !== null && apply((d) => ({ ...d, canvasWidth: v }), 'plan:w')}
          />
          <NumberField
            label={t('fields.canvasHeight')}
            value={doc.canvasHeight}
            integer
            min={100}
            max={100_000}
            onChange={(v) => v !== null && apply((d) => ({ ...d, canvasHeight: v }), 'plan:h')}
          />
        </div>
      </PanelSection>
      {planCategories && <PlanCategoriesSection doc={doc} apply={apply} />}
      <PanelSection title={t('panel.display')}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('fields.gridSize')}
            value={s.gridSize}
            min={1}
            max={1000}
            onChange={(v) => v !== null && setSettings({ gridSize: v }, 'grid')}
          />
          <NumberField
            label={t('fields.seatRadius')}
            value={s.seatRadius}
            min={1}
            max={500}
            onChange={(v) => v !== null && setSettings({ seatRadius: v }, 'radius')}
          />
        </div>
        <SymbolPicker
          label={t('fields.defaultSeatShape')}
          symbols={symbols}
          kind="SEAT"
          value={s.defaultSeatSymbolId ?? null}
          previewColor={COLORS.noCategory}
          noneLabel={t('symbols.circle')}
          hint={t('hints.defaultSeatShape')}
          onChange={(defaultSeatSymbolId) => setSettings({ defaultSeatSymbolId }, 'seatShape')}
        />
        <SwitchField
          label={t('fields.snapToGrid')}
          checked={s.snapToGrid}
          onChange={(v) => setSettings({ snapToGrid: v }, 'snap')}
        />
        <SwitchField
          label={t('fields.showSeatNumbers')}
          checked={s.showSeatNumbers}
          onChange={(v) => setSettings({ showSeatNumbers: v }, 'numbers')}
        />
      </PanelSection>
      <PanelSection title={t('panel.specialSeats')}>
        <SpecialSeatLabelField
          kind="wheelchair"
          value={s.wheelchairLabel}
          onChange={(wheelchairLabel) => setSettings({ wheelchairLabel }, 'wheelchairLabel')}
        />
        <SpecialSeatLabelField
          kind="companion"
          value={s.companionLabel}
          onChange={(companionLabel) => setSettings({ companionLabel }, 'companionLabel')}
        />
        <p className="text-[11px] text-muted-foreground">{t('hints.specialSeatLabels')}</p>
      </PanelSection>
      <PanelSection title={t('panel.help')}>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {(
            ['select', 'pan', 'zoom', 'multi', 'row', 'delete', 'undo', 'nudge', 'save'] as const
          ).map((k) => (
            <li key={k}>{t(`help.${k}`)}</li>
          ))}
        </ul>
      </PanelSection>
    </>
  );
}
