/**
 * The PDF standard fonts (Helvetica) only cover WinAnsi (Windows-1252): all of Latin-1 incl.
 * German umlauts and ß, plus € „ “ ” ‚ ‘ ’ – — … • ™ Š š Ž ž Œ œ Ÿ ƒ ˆ ˜ † ‡ ‰ ‹ ›.
 * Everything else is transliterated (é → e is not needed – é is Latin-1 – but ł → l,
 * č → c, narrow no-break space → space) or replaced by "?" so rendering never fails.
 */

const WIN_ANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((ch) => ch.codePointAt(0)!));

export function isWinAnsi(codePoint: number): boolean {
  return (
    codePoint === 0x0a ||
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    WIN_ANSI_EXTRA.has(codePoint)
  );
}

const REPLACEMENTS: Record<string, string> = {
  '\t': ' ',
  '\r': '',
  '\u2007': ' ',
  '\u2009': ' ',
  '\u202f': '\u00a0',
  '\u2011': '-',
  '\u2012': '–',
  '\u2212': '-',
  '\u2032': "'",
  '\u2033': '"',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ı: 'i',
  ħ: 'h',
  Ħ: 'H',
  ŀ: 'l',
  Ŀ: 'L',
  ŋ: 'n',
  Ŋ: 'N',
  ſ: 's',
  ẞ: 'SS',
  '♿': '',
};

/** Text that can be drawn with a WinAnsi standard font. */
export function toWinAnsi(input: string): string {
  let out = '';
  for (const ch of input.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if (isWinAnsi(cp)) {
      out += ch;
      continue;
    }
    const mapped = REPLACEMENTS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    // Strip diacritics (NFD): c-caron -> c
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (base === '') continue; // lone combining mark
    out += [...base].every((c) => isWinAnsi(c.codePointAt(0)!)) ? base : '?';
  }
  return out;
}
