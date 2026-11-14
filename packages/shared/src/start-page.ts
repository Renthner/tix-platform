import type { StartPageSettings, StartPageText } from './schemas/settings';

export interface ResolvedStartPage {
  headline: string | undefined;
  subheadline: string | undefined;
  body: string | undefined;
  buttonLabel: string | undefined;
  heroAlt: string;
  galleryAlt: string[];
}

/** First non-empty value of the requested locale, else of the shop default locale. */
function pick(
  texts: StartPageSettings['texts'],
  locale: string,
  defaultLocale: string,
  field: Exclude<keyof StartPageText, 'galleryAlt'>,
): string | undefined {
  const own = (texts as Record<string, StartPageText | undefined>)[locale]?.[field];
  if (own) return own;
  return (texts as Record<string, StartPageText | undefined>)[defaultLocale]?.[field] || undefined;
}

/** Start page texts for `locale`; every missing field falls back to the shop default locale. */
export function resolveStartPageTexts(
  settings: Pick<StartPageSettings, 'texts' | 'galleryAssetIds'>,
  locale: string,
  defaultLocale: string,
): ResolvedStartPage {
  const t = settings.texts as Record<string, StartPageText | undefined>;
  return {
    headline: pick(settings.texts, locale, defaultLocale, 'headline'),
    subheadline: pick(settings.texts, locale, defaultLocale, 'subheadline'),
    body: pick(settings.texts, locale, defaultLocale, 'body'),
    buttonLabel: pick(settings.texts, locale, defaultLocale, 'buttonLabel'),
    heroAlt: pick(settings.texts, locale, defaultLocale, 'heroAlt') ?? '',
    galleryAlt: settings.galleryAssetIds.map(
      (_, i) => t[locale]?.galleryAlt?.[i] || t[defaultLocale]?.galleryAlt?.[i] || '',
    ),
  };
}

/** Custom HTML of `locale`, else of the shop default locale (empty = none). */
export function resolveStartPageHtml(
  settings: Pick<StartPageSettings, 'texts'>,
  locale: string,
  defaultLocale: string,
): string {
  const t = settings.texts as Record<string, StartPageText | undefined>;
  return t[locale]?.html?.trim() || t[defaultLocale]?.html?.trim() || '';
}
