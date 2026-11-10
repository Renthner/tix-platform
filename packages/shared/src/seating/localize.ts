import { localized } from '../translations';
import type { PublicSeatMap } from './public';

/**
 * Resolves the content translations carried in the public plan payload (`tr`) for one locale and
 * drops them. Pure – applied after the (locale independent) cached snapshot was loaded.
 */
export function localizePublicSeatMap(
  map: PublicSeatMap,
  locale: string | null | undefined,
  defaultLocale: string,
): PublicSeatMap {
  const L = <T extends { tr?: unknown }>(e: T, field: string, base: string | null) =>
    localized(
      { translations: e.tr as Record<string, Record<string, string>> | undefined },
      field,
      locale,
      defaultLocale,
      base,
    );
  const strip = <T extends { tr?: unknown }>(e: T): Omit<T, 'tr'> => {
    const { tr: _tr, ...rest } = e;
    return rest;
  };
  const settings = { ...map.settings };
  const st = settings.translations;
  for (const [key, field] of [
    ['wheelchairLabel', 'wheelchairLabelText'],
    ['companionLabel', 'companionLabelText'],
  ] as const) {
    const current = settings[key];
    if (current) {
      const text = localized(
        { translations: st },
        field,
        locale,
        defaultLocale,
        current.text ?? '',
      );
      settings[key] = { ...current, ...(text ? { text } : {}) };
    }
  }
  delete settings.translations;
  return {
    ...map,
    settings,
    categories: map.categories.map((c) => ({ ...strip(c), name: L(c, 'name', c.name) })),
    ticketTypes: map.ticketTypes.map((t) => ({
      ...strip(t),
      name: L(t, 'name', t.name),
      description:
        t.description === null
          ? L(t, 'description', null) || null
          : L(t, 'description', t.description),
    })),
    sections: map.sections.map((s) => ({
      ...strip(s),
      name: L(s, 'name', s.name),
      ticketLabel: L(s, 'ticketLabel', s.ticketLabel),
    })),
    elements: map.elements.map((e) => ({
      ...strip(e),
      label: e.label === null ? L(e, 'label', null) || null : L(e, 'label', e.label),
    })),
    entrances: map.entrances.map((e) => ({ ...strip(e), name: L(e, 'name', e.name) })),
  };
}
