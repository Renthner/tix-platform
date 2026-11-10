import {
  TRANSLATABLE_FIELDS,
  applyTranslations,
  type EventInfoBox,
  type Translations,
  normalizeLocale,
} from '@tix/shared';
import { getSetting } from './settings';
import type { CoreContext } from './context';

/**
 * Locale used to resolve content translations: the requested one (a regional tag falls back to
 * its language), or the shop default language when none / the default itself is requested.
 */
export async function contentLocale(
  ctx: Pick<CoreContext, 'db'>,
  requested?: string | null,
): Promise<{ locale: string; defaultLocale: string }> {
  const defaultLocale = normalizeLocale((await getSetting(ctx, 'general')).defaultLocale);
  return { locale: requested || defaultLocale, defaultLocale };
}

type WithTranslations = { translations?: Translations | null };

/** Event with title / subtitle / description and the info boxes resolved for `locale`. */
export function localizeEventRow<E extends WithTranslations & { infoBoxes: EventInfoBox[] }>(
  event: E,
  locale: string | null | undefined,
  defaultLocale: string,
): E {
  return {
    ...applyTranslations(
      event,
      TRANSLATABLE_FIELDS.event.map((f) => f.name),
      locale,
      defaultLocale,
    ),
    infoBoxes: event.infoBoxes.map((box) =>
      applyTranslations(
        box,
        TRANSLATABLE_FIELDS.infoBox.map((f) => f.name),
        locale,
        defaultLocale,
      ),
    ),
  };
}

/** Venue with its customer-facing name and description resolved for `locale`. */
export function localizeVenueRow<V extends WithTranslations>(
  venue: V,
  locale: string | null | undefined,
  defaultLocale: string,
): V {
  return applyTranslations(
    venue,
    TRANSLATABLE_FIELDS.venue.map((f) => f.name),
    locale,
    defaultLocale,
  );
}
