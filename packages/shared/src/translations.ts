import { z } from 'zod';
import { SUPPORTED_LOCALES, normalizeLocale, type AppLocale } from './i18n';

/**
 * Content translations. The base text lives in the entity's normal columns and is written in the
 * shop default language (`general.defaultLocale`). Translations are stored next to it as
 * `{ "<locale>": { "<field>": "<text>" } }` (column `translations` jsonb, default `{}`).
 */
export type Translations = Partial<Record<string, Record<string, string>>>;

export const TRANSLATION_FIELD_MAX = 50_000;

/** Stored shape: only supported locales, string values. Unknown locales are rejected. */
export const translationsSchema = z.partialRecord(
  z.enum(SUPPORTED_LOCALES),
  z.record(z.string().min(1).max(64), z.string().max(TRANSLATION_FIELD_MAX)),
);

/**
 * Translatable fields per entity type. `rich` fields hold sanitised HTML (same sanitiser as the
 * base field), `max` is the limit of the base field.
 */
export interface TranslatableField {
  readonly name: string;
  readonly rich?: boolean;
  readonly max: number;
}
const f = (name: string, max: number, rich = false): TranslatableField => ({ name, max, rich });

export const TRANSLATABLE_FIELDS = {
  event: [f('title', 200), f('subtitle', 300), f('description', 50_000, true)],
  priceCategory: [f('name', 80), f('description', 500)],
  ticketType: [f('name', 80), f('description', 500)],
  fee: [f('name', 120)],
  queueConfig: [f('title', 200), f('message', 2000)],
  queueAnnouncement: [f('message', 2000)],
  venue: [f('name', 200), f('description', 50_000, true)],
  section: [f('name', 120), f('ticketLabel', 120)],
  element: [f('label', 200)],
  entrance: [f('name', 120)],
  seatMap: [f('wheelchairLabelText', 3), f('companionLabelText', 3)],
  infoBox: [f('title', 120), f('content', 50_000, true)],
} as const satisfies Record<string, readonly TranslatableField[]>;
export type TranslatableEntity = keyof typeof TRANSLATABLE_FIELDS;

/** Rich-text HTML without visible content (`<p></p>`, `<p><br></p>` …) counts as empty. */
export function isBlankText(value: string | null | undefined): boolean {
  if (value == null) return true;
  if (value.trim() === '') return true;
  if (!/[<&]/.test(value)) return false;
  const stripped = value
    .replace(/<(?!img\b)[^>]*>/gi, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .trim();
  return stripped === '' && !/<img\b/i.test(value);
}

/**
 * Text of `field` in `locale`: the translation if present and not blank, otherwise the base value.
 * The default locale always shows the base text.
 */
export function localized<T extends object>(
  entity: (T & { translations?: Translations | null }) | null | undefined,
  field: string,
  locale: string | null | undefined,
  defaultLocale: string,
  base?: string | null,
): string {
  const baseText =
    base !== undefined ? base : ((entity as Record<string, unknown> | null)?.[field] as unknown);
  const fallback = typeof baseText === 'string' ? baseText : '';
  const lang = (tag: string) => tag.split('-')[0]!.toLowerCase();
  if (!entity || !locale || lang(locale) === lang(defaultLocale)) return fallback;
  const candidates = [locale, lang(locale)];
  for (const l of candidates) {
    const value = entity.translations?.[l]?.[field];
    if (typeof value === 'string' && !isBlankText(value)) return value;
  }
  return fallback;
}

/** Like `localized`, but keeps `null` when the base value is null and there is no translation. */
export function localizedNullable<T extends { translations?: Translations | null }>(
  entity: T,
  field: string,
  locale: string | null | undefined,
  defaultLocale: string,
): string | null {
  const base = (entity as Record<string, unknown>)[field];
  const baseText = typeof base === 'string' ? base : null;
  const result = localized(entity, field, locale, defaultLocale, baseText);
  return result === '' && baseText === null ? null : result;
}

/** Locales a content editor can translate into (all but the shop default). */
export function translationLocales(defaultLocale: string): AppLocale[] {
  // Compare base languages: a regional default such as "de-DE" is still German.
  const base = normalizeLocale(defaultLocale);
  return SUPPORTED_LOCALES.filter((l) => l !== base);
}

/** Merges `fields` of one locale into `translations`; blank values remove the field. Pure. */
export function mergeLocaleTranslations(
  existing: Translations | null | undefined,
  locale: string,
  fields: Record<string, string | null | undefined>,
): Translations {
  const next: Translations = { ...(existing ?? {}) };
  const forLocale = { ...(next[locale] ?? {}) };
  for (const [key, value] of Object.entries(fields)) {
    if (isBlankText(value)) delete forLocale[key];
    else forLocale[key] = value as string;
  }
  if (Object.keys(forLocale).length) next[locale] = forLocale;
  else delete next[locale];
  return next;
}

/** Counts translatable fields that have base text and how many of them are translated. */
export function translationCompleteness(
  items: readonly {
    translations?: Translations | null;
    base: Record<string, string | null | undefined>;
  }[],
  locale: string,
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const item of items) {
    for (const [field, base] of Object.entries(item.base)) {
      if (isBlankText(base)) continue;
      total++;
      if (!isBlankText(item.translations?.[locale]?.[field])) done++;
    }
  }
  return { done, total };
}

/** Drops translations of unsupported locales / unknown fields (import, legacy data). */
export function cleanTranslations(input: unknown, entity: TranslatableEntity): Translations {
  const parsed = translationsSchema.safeParse(input);
  if (!parsed.success) return {};
  const allowed = new Set<string>(TRANSLATABLE_FIELDS[entity].map((x) => x.name));
  const out: Translations = {};
  for (const [locale, fields] of Object.entries(parsed.data)) {
    const kept = Object.fromEntries(
      Object.entries(fields ?? {}).filter(([k, v]) => allowed.has(k) && !isBlankText(v)),
    );
    if (Object.keys(kept).length) out[locale] = kept;
  }
  return out;
}

/** Copy of `entity` with the given text fields resolved for `locale` (null stays null without translation). */
export function applyTranslations<T extends { translations?: Translations | null }>(
  entity: T,
  fields: readonly string[],
  locale: string | null | undefined,
  defaultLocale: string,
): T {
  const out = { ...entity } as Record<string, unknown>;
  for (const field of fields) {
    const base = out[field];
    if (typeof base === 'string' || base === null || base === undefined) {
      const text = localized(entity, field, locale, defaultLocale, (base as string | null) ?? null);
      out[field] = text === '' && base == null ? base : text;
    }
  }
  return out as T;
}
