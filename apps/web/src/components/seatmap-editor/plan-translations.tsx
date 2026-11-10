'use client';

import { mergeLocaleTranslations, type Translations } from '@tix/shared';
import { useLocale, useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import type { Doc } from './model';

type Apply = (update: (doc: Doc) => Doc, coalesceKey?: string) => void;

/**
 * Text properties of the plan in a translation language: block names / ticket labels, element
 * labels (stage, exits, facilities, text), entrance names and the short wheelchair / companion
 * label texts. The base text is shown as placeholder; empty = falls back to the base text.
 * Edits go through the normal editor state and are saved with the plan.
 */
export function PlanTranslationPanel({
  doc,
  apply,
  editLocale,
  baseLocale,
}: {
  doc: Doc;
  apply: Apply;
  editLocale: string;
  baseLocale: string;
}) {
  const t = useTranslations('translations');
  const tk = t as unknown as (key: string) => string;
  const uiLocale = useLocale();
  const names = new Intl.DisplayNames([uiLocale], { type: 'language' });
  const language = names.of(editLocale) ?? editLocale;

  const row = (
    key: string,
    base: string,
    current: Translations | undefined,
    field: string,
    max: number,
    labelKey: string,
    set: (translations: Translations) => (doc: Doc) => Doc,
  ) => (
    <label key={`${key}:${field}`} className="block space-y-1">
      <span className="text-xs text-muted-foreground">{tk(`editor.${labelKey}`)}</span>
      <Input
        value={current?.[editLocale]?.[field] ?? ''}
        placeholder={base}
        maxLength={max}
        onChange={(e) => {
          const next = mergeLocaleTranslations(current, editLocale, { [field]: e.target.value });
          apply(set(next), `tr:${key}:${field}`);
        }}
      />
    </label>
  );

  const settingsTr = doc.settings.translations;
  const setSettings = (translations: Translations) => (d: Doc) => ({
    ...d,
    settings: { ...d.settings, translations },
  });
  const textLabels = [
    ['wheelchairLabel', 'wheelchairLabelText'],
    ['companionLabel', 'companionLabelText'],
  ] as const;
  const settingsRows = textLabels.filter(([key]) => doc.settings[key]?.mode === 'TEXT');
  const elements = doc.elements.filter((e) => e.label);
  const empty =
    doc.sections.length === 0 &&
    elements.length === 0 &&
    doc.entrances.length === 0 &&
    doc.categories.length === 0 &&
    settingsRows.length === 0;

  return (
    <div className="space-y-5 p-4">
      <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
        {t('editor.banner', { language })}
        <span className="mt-1 block">
          {t('pane.intro', { language, base: names.of(baseLocale) ?? baseLocale })}
        </span>
      </p>
      {empty && <p className="text-sm text-muted-foreground">{t('editor.empty')}</p>}
      {doc.sections.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t('editor.sections')}</h2>
          {doc.sections.map((s) => (
            <div key={s.id} className="space-y-2 rounded-md border p-3">
              {row(s.id, s.name, s.translations, 'name', 120, 'name', (translations) => (d) => ({
                ...d,
                sections: d.sections.map((x) => (x.id === s.id ? { ...x, translations } : x)),
              }))}
              {row(
                s.id,
                s.ticketLabel,
                s.translations,
                'ticketLabel',
                120,
                'ticketLabel',
                (translations) => (d) => ({
                  ...d,
                  sections: d.sections.map((x) => (x.id === s.id ? { ...x, translations } : x)),
                }),
              )}
            </div>
          ))}
        </section>
      )}
      {elements.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t('editor.elements')}</h2>
          {elements.map((e) => (
            <div key={e.id} className="rounded-md border p-3">
              {row(
                e.id,
                e.label ?? '',
                e.translations,
                'label',
                200,
                'label',
                (translations) => (d) => ({
                  ...d,
                  elements: d.elements.map((x) => (x.id === e.id ? { ...x, translations } : x)),
                }),
              )}
            </div>
          ))}
        </section>
      )}
      {doc.entrances.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t('editor.entrances')}</h2>
          {doc.entrances.map((e) => (
            <div key={e.id} className="rounded-md border p-3">
              {row(e.id, e.name, e.translations, 'name', 120, 'name', (translations) => (d) => ({
                ...d,
                entrances: d.entrances.map((x) => (x.id === e.id ? { ...x, translations } : x)),
              }))}
            </div>
          ))}
        </section>
      )}
      {doc.categories.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t('editor.categories')}</h2>
          {doc.categories.map((c) => (
            <div key={c.id} className="rounded-md border p-3">
              {row(c.id, c.name, c.translations, 'name', 80, 'name', (translations) => (d) => ({
                ...d,
                categories: d.categories.map((x) => (x.id === c.id ? { ...x, translations } : x)),
              }))}
            </div>
          ))}
        </section>
      )}
      {settingsRows.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t('editor.settings')}</h2>
          <div className="space-y-2 rounded-md border p-3">
            {settingsRows.map(([key, field]) =>
              row(
                'settings',
                doc.settings[key]?.text ?? '',
                settingsTr,
                field,
                3,
                field,
                setSettings,
              ),
            )}
          </div>
        </section>
      )}
    </div>
  );
}
