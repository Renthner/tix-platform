/**
 * Windows-1252 (CP1252) encoder without a dependency. DATEV files are expected in this code page.
 * Characters outside it (emoji, Cyrillic, …) become "?" – never a crash, never mojibake.
 */

const decoder = new TextDecoder('windows-1252');

/** Unicode code point → byte, built once from the WHATWG decoder (covers 0x80–0x9F: €, „, …). */
const REVERSE = new Map<number, number>();
for (let byte = 0; byte < 256; byte++) {
  const cp = decoder.decode(Uint8Array.of(byte)).codePointAt(0)!;
  // 0x81, 0x8D, 0x8F, 0x90, 0x9D are undefined in CP1252 (the decoder maps them to C1 controls).
  if (byte >= 0x80 && byte <= 0x9f && cp === byte) continue;
  REVERSE.set(cp, byte);
}

export function encodeCp1252(text: string): Buffer {
  const out: number[] = [];
  for (const char of text) {
    out.push(REVERSE.get(char.codePointAt(0)!) ?? 0x3f);
  }
  return Buffer.from(out);
}
