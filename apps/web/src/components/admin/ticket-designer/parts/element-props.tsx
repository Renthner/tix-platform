'use client';

import {
  TICKET_FONT_FAMILIES,
  mergeLocaleTranslations,
  type TicketLayoutElement,
  type TicketTextElement,
} from '@tix/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import type { ElementPatch } from '../canvas';
import { ColorField, NumberField, Select } from './fields';
import { StaticTextField } from './static-text-field';

export function ElementProps({
  element,
  fieldOptions,
  baseLocale,
  translationLocales,
  onChange,
}: {
  element: TicketLayoutElement;
  fieldOptions: { value: TicketTextElement['field']; label: string }[];
  baseLocale: string;
  translationLocales: string[];
  onChange: (patch: ElementPatch) => void;
}) {
  const t = useTranslations('ticketDesigner.props');
  const uiLocale = useLocale();
  const [textLocale, setTextLocale] = useState(baseLocale);
  const languageName = (l: string) =>
    new Intl.DisplayNames([uiLocale], { type: 'language' }).of(l) ?? l;
  const geometry = (
    <div className="grid grid-cols-4 gap-2">
      <NumberField label="X" value={element.x} min={0} onChange={(x) => onChange({ x })} />
      <NumberField label="Y" value={element.y} min={0} onChange={(y) => onChange({ y })} />
      <NumberField
        label="W"
        value={element.width}
        min={0}
        onChange={(width) => onChange({ width })}
      />
      <NumberField
        label="H"
        value={element.height}
        min={0}
        onChange={(height) => onChange({ height })}
      />
    </div>
  );
  const rotation =
    'rotation' in element ? (
      <NumberField
        label={t('rotation')}
        value={element.rotation}
        min={-360}
        max={360}
        step={1}
        onChange={(rotation) => onChange({ rotation })}
      />
    ) : null;

  if (element.kind === 'text') {
    return (
      <div className="space-y-3">
        <Select
          label={t('field')}
          value={element.field}
          options={fieldOptions}
          onChange={(field) => onChange({ field })}
        />
        {element.field === 'STATIC_TEXT' && (
          <>
            {translationLocales.length > 0 && (
              <Select
                label={t('textLanguage')}
                value={textLocale}
                options={[baseLocale, ...translationLocales].map((l) => ({
                  value: l,
                  label:
                    l === baseLocale
                      ? `${languageName(l)} ${t('textLanguageDefault')}`
                      : languageName(l),
                }))}
                onChange={setTextLocale}
              />
            )}
            <StaticTextField
              key={textLocale}
              value={
                textLocale === baseLocale
                  ? (element.text ?? '')
                  : ((
                      element.translations as
                        Record<string, Record<string, string> | undefined> | undefined
                    )?.[textLocale]?.text ?? '')
              }
              onChange={(text) =>
                textLocale === baseLocale
                  ? onChange({ text })
                  : onChange({
                      translations: mergeLocaleTranslations(element.translations, textLocale, {
                        text,
                      }),
                    })
              }
            />
          </>
        )}
        {geometry}
        <div className="grid grid-cols-2 gap-2">
          {rotation}
          <NumberField
            label={t('fontSize')}
            value={element.fontSize}
            min={3}
            max={200}
            step={0.5}
            onChange={(fontSize) => onChange({ fontSize })}
          />
          <Select
            label={t('fontFamily')}
            value={
              (TICKET_FONT_FAMILIES as readonly string[]).includes(element.fontFamily)
                ? element.fontFamily
                : TICKET_FONT_FAMILIES[0]
            }
            options={TICKET_FONT_FAMILIES.map((f) => ({ value: f as string, label: f }))}
            onChange={(fontFamily) => onChange({ fontFamily })}
          />
          <Select
            label={t('weight')}
            value={element.fontWeight}
            options={[
              { value: 'normal', label: t('normal') },
              { value: 'bold', label: t('bold') },
            ]}
            onChange={(fontWeight) => onChange({ fontWeight })}
          />
          <Select
            label={t('align')}
            value={element.align}
            options={[
              { value: 'left', label: t('left') },
              { value: 'center', label: t('center') },
              { value: 'right', label: t('right') },
            ]}
            onChange={(align) => onChange({ align })}
          />
          <ColorField
            label={t('color')}
            value={element.color}
            onChange={(v) => v && onChange({ color: v })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={element.uppercase}
            onCheckedChange={(uppercase) => onChange({ uppercase })}
          />
          {t('uppercase')}
        </label>
        {['EVENT_DATE', 'EVENT_TIME', 'DOORS_TIME', 'STATIC_TEXT'].includes(element.field) && (
          <div className="grid grid-cols-2 gap-2">
            <Select
              label={t('dateStyle')}
              value={element.dateStyle ?? 'long'}
              options={(['short', 'medium', 'long', 'full'] as const).map((v) => ({
                value: v,
                label: t(`dateStyles.${v}`),
              }))}
              onChange={(dateStyle) => onChange({ dateStyle })}
            />
            <Select
              label={t('timeStyle')}
              value={element.timeStyle ?? 'short'}
              options={(['short', 'medium'] as const).map((v) => ({
                value: v,
                label: t(`timeStyles.${v}`),
              }))}
              onChange={(timeStyle) => onChange({ timeStyle })}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('fitHint')}</p>
      </div>
    );
  }
  if (element.kind === 'shape') {
    return (
      <div className="space-y-3">
        {geometry}
        <div className="grid grid-cols-2 gap-2">
          <ColorField
            label={t('fill')}
            value={element.fill}
            clearable
            clearLabel={t('none')}
            onChange={(fill) => onChange({ fill })}
          />
          <ColorField
            label={t('stroke')}
            value={element.stroke}
            clearable
            clearLabel={t('none')}
            onChange={(stroke) => onChange({ stroke })}
          />
          <NumberField
            label={t('strokeWidth')}
            value={element.strokeWidth}
            min={0}
            max={20}
            step={0.1}
            onChange={(strokeWidth) => onChange({ strokeWidth })}
          />
        </div>
      </div>
    );
  }
  if (element.kind === 'cover') {
    return (
      <div className="space-y-3">
        {geometry}
        <div className="grid grid-cols-2 gap-2">
          <Select
            label={t('fit')}
            value={element.fit}
            options={[
              { value: 'cover', label: t('fitCover') },
              { value: 'contain', label: t('fitContain') },
            ]}
            onChange={(fit) => onChange({ fit })}
          />
          <NumberField
            label={t('opacity')}
            value={element.opacity}
            min={0}
            max={1}
            step={0.1}
            onChange={(opacity) => onChange({ opacity: Math.min(1, Math.max(0, opacity)) })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('coverHint')}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {geometry}
      <div className="grid grid-cols-2 gap-2">
        {rotation}
        <NumberField
          label={t('opacity')}
          value={element.opacity}
          min={0}
          max={1}
          step={0.1}
          onChange={(opacity) => onChange({ opacity: Math.min(1, Math.max(0, opacity)) })}
        />
      </div>
    </div>
  );
}
