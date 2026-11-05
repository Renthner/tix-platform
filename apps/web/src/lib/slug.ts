const TRANSLITERATION: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  ø: 'oe',
  å: 'aa',
};

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** URL slug from a title: transliterates umlauts, strips diacritics, max 80 characters. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[äöüßæøå]/g, (c) => TRANSLITERATION[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}
