import { describe, expect, it } from 'vitest';
import {
  PUBLIC_MAP_FORMAT,
  applyTranslations,
  cleanTranslations,
  isBlankText,
  localizeTicketLayout,
  type TicketLayout,
  localizePublicSeatMap,
  localized,
  mergeLocaleTranslations,
  seatMapFileSchema,
  translationCompleteness,
  translationsSchema,
  type PublicSeatMap,
} from '../src';

describe('localized()', () => {
  const entity = {
    name: 'Parkett',
    translations: { en: { name: 'Stalls', description: '' } },
  };

  it('returns the translation for a non-default locale', () => {
    expect(localized(entity, 'name', 'en', 'de')).toBe('Stalls');
  });

  it('always shows the base text in the default locale', () => {
    expect(localized(entity, 'name', 'de', 'de')).toBe('Parkett');
    // regional tags compare by language
    expect(localized(entity, 'name', 'de-AT', 'de')).toBe('Parkett');
  });

  it('falls back to the base text for missing, empty and blank translations', () => {
    expect(localized(entity, 'description', 'en', 'de', 'Basis')).toBe('Basis');
    expect(
      localized({ ...entity, translations: { en: { name: '   ' } } }, 'name', 'en', 'de'),
    ).toBe('Parkett');
    expect(
      localized({ ...entity, translations: { en: { name: '<p><br></p>' } } }, 'name', 'en', 'de'),
    ).toBe('Parkett');
    expect(localized({ name: 'x', translations: {} }, 'name', 'en', 'de')).toBe('x');
    const noTranslations = { name: 'x' };
    expect(localized(noTranslations, 'name', 'en', 'de')).toBe('x');
  });

  it('resolves regional locales through their language and tolerates missing locale', () => {
    expect(localized(entity, 'name', 'en-GB', 'de')).toBe('Stalls');
    expect(localized(entity, 'name', undefined, 'de')).toBe('Parkett');
    expect(localized(null, 'name', 'en', 'de')).toBe('');
  });

  it('applyTranslations keeps null bases and replaces translated text', () => {
    const row = { title: 'Gala', subtitle: null, translations: { en: { title: 'Gala night' } } };
    const out = applyTranslations(row, ['title', 'subtitle'], 'en', 'de');
    expect(out.title).toBe('Gala night');
    expect(out.subtitle).toBeNull();
  });
});

describe('isBlankText()', () => {
  it('treats empty rich text as blank', () => {
    for (const v of ['', ' ', '<p></p>', '<p><br></p>', '<p>&nbsp;</p>', null, undefined]) {
      expect(isBlankText(v)).toBe(true);
    }
    expect(isBlankText('<p>Hi</p>')).toBe(false);
    expect(isBlankText('a < b')).toBe(false);
  });
});

describe('mergeLocaleTranslations()', () => {
  it('writes one locale without touching others or other fields', () => {
    const existing = { de: { name: 'A', description: 'B' }, fr: { name: 'C' } };
    const next = mergeLocaleTranslations(existing, 'en', { name: 'X' });
    expect(next).toEqual({ ...existing, en: { name: 'X' } });
    expect(existing).not.toHaveProperty('en');
    const again = mergeLocaleTranslations(next, 'en', { description: 'Y' });
    expect(again.en).toEqual({ name: 'X', description: 'Y' });
  });

  it('removes blank fields and empty locales', () => {
    const next = mergeLocaleTranslations({ en: { name: 'X' }, de: { name: 'Y' } }, 'en', {
      name: '',
    });
    expect(next).toEqual({ de: { name: 'Y' } });
  });
});

describe('translations schema & helpers', () => {
  it('accepts supported locales only', () => {
    expect(translationsSchema.safeParse({ en: { name: 'x' } }).success).toBe(true);
    expect(translationsSchema.safeParse({ xx: { name: 'x' } }).success).toBe(false);
    expect(translationsSchema.safeParse({ en: { name: 5 } }).success).toBe(false);
  });

  it('cleanTranslations drops unknown fields, blanks and unsupported locales', () => {
    expect(
      cleanTranslations({ en: { name: 'Stalls', evil: 'x', ticketLabel: ' ' } }, 'section'),
    ).toEqual({ en: { name: 'Stalls' } });
    expect(cleanTranslations({ xx: { name: 'a' } }, 'section')).toEqual({});
    expect(cleanTranslations('garbage', 'section')).toEqual({});
  });

  it('counts translated texts per locale and ignores empty base texts', () => {
    const result = translationCompleteness(
      [
        { translations: { en: { title: 'T' } }, base: { title: 'Titel', subtitle: 'Sub' } },
        { translations: {}, base: { title: 'Zwei', description: '' } },
      ],
      'en',
    );
    expect(result).toEqual({ done: 1, total: 3 });
  });
});

describe('localizePublicSeatMap()', () => {
  const map = {
    eventId: 'e',
    version: 1,
    canvasWidth: 1,
    canvasHeight: 1,
    settings: {
      wheelchairLabel: { mode: 'TEXT', text: 'R' },
      translations: { en: { wheelchairLabelText: 'W' } },
    },
    backgroundUrl: null,
    currency: 'EUR',
    categories: [
      {
        id: 'c',
        name: 'Kategorie 1',
        color: '#fff',
        basePrice: 1,
        sortOrder: 0,
        maxPerOrder: null,
        bestAvailable: true,
        tr: { en: { name: 'Category 1' } },
      },
    ],
    ticketTypes: [
      {
        id: 't',
        name: 'Normal',
        description: null,
        isDefault: true,
        requiresProofAtEntry: false,
        requiredSeatFeature: null,
        maxPerOrder: null,
        bestAvailable: true,
        sortOrder: 0,
        prices: {},
        tr: { en: { name: 'Standard' } },
      },
    ],
    sections: [
      {
        id: 's',
        type: 'SEATED',
        name: 'Parkett',
        ticketLabel: 'Parkett',
        tr: { en: { name: 'Stalls' } },
      },
    ],
    rows: [],
    elements: [
      { id: 'el', type: 'STAGE', label: 'Bühne', tr: { en: { label: 'Stage' } } },
      { id: 'el2', type: 'SHAPE', label: null },
    ],
    entrances: [
      {
        id: 'en',
        name: 'Haupteingang',
        code: 'A',
        x: 0,
        y: 0,
        tr: { en: { name: 'Main entrance' } },
      },
    ],
    seats: [],
    symbols: [],
  } as unknown as PublicSeatMap;

  it('resolves plan texts for English and keeps German as base', () => {
    const en = localizePublicSeatMap(map, 'en', 'de');
    expect(en.categories[0]).toMatchObject({ name: 'Category 1' });
    expect(en.categories[0]).not.toHaveProperty('tr');
    expect(en.ticketTypes[0]!.name).toBe('Standard');
    expect(en.sections[0]).toMatchObject({ name: 'Stalls', ticketLabel: 'Parkett' });
    expect(en.elements[0]!.label).toBe('Stage');
    expect(en.elements[1]!.label).toBeNull();
    expect(en.entrances[0]!.name).toBe('Main entrance');
    expect(en.settings.wheelchairLabel?.text).toBe('W');
    expect(en.settings.translations).toBeUndefined();

    const de = localizePublicSeatMap(map, 'de', 'de');
    expect(de.categories[0]!.name).toBe('Kategorie 1');
    expect(de.sections[0]!.name).toBe('Parkett');
    expect(de.settings.wheelchairLabel?.text).toBe('R');
  });

  it('bumps the snapshot format so cached snapshots without translations are not served', () => {
    expect(PUBLIC_MAP_FORMAT).toBeGreaterThanOrEqual(5);
  });
});

describe('seat plan file', () => {
  const base = {
    format: 'tix-seatmap',
    exportedAt: '2026-01-01T00:00:00Z',
    source: { appVersion: '1' },
    plan: { name: 'P', canvasWidth: 500, canvasHeight: 300 },
  };
  it('accepts version 1 and 2 files', () => {
    expect(seatMapFileSchema.safeParse({ ...base, version: 1 }).success).toBe(true);
    expect(seatMapFileSchema.safeParse({ ...base, version: 2 }).success).toBe(true);
    expect(seatMapFileSchema.safeParse({ ...base, version: 3 }).success).toBe(false);
  });
});

describe('localizeTicketLayout()', () => {
  const layout = {
    version: 1,
    qr: {},
    elements: [
      {
        kind: 'text',
        id: 'a',
        field: 'STATIC_TEXT',
        text: 'Eintritt',
        translations: { en: { text: 'Admission' } },
      },
      { kind: 'text', id: 'b', field: 'STATIC_TEXT', text: 'Nur Basis' },
      { kind: 'text', id: 'c', field: 'EVENT_TITLE' },
    ],
  } as unknown as TicketLayout;

  it('resolves static texts by locale, falling back to the base text', () => {
    const en = localizeTicketLayout(layout, 'en', 'de');
    expect(en.elements.map((e) => (e.kind === 'text' ? e.text : null))).toEqual([
      'Admission',
      'Nur Basis',
      undefined,
    ]);
    const de = localizeTicketLayout(layout, 'de', 'de');
    expect(de.elements[0]).toMatchObject({ text: 'Eintritt' });
  });
});
