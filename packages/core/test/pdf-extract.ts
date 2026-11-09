import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';

/**
 * Test helper: strings drawn with `Tj`, decoded to Unicode. Subset-embedded fonts are decoded
 * with their ToUnicode CMap, standard fonts as WinAnsi/Latin-1.
 */

function streamText(stream: PDFRawStream): string {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
}

function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const utf16 = (hex: string) => Buffer.from(hex, 'hex').swap16().toString('utf16le');
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1]!, 16), utf16(m[2]!));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(m[1]!, 16);
      const end = parseInt(m[2]!, 16);
      const base = utf16(m[3]!).codePointAt(0)!;
      for (let code = start; code <= end; code += 1) {
        map.set(code, String.fromCodePoint(base + code - start));
      }
    }
  }
  return map;
}

export async function extractPdfText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const { Resources, Contents } = page.node.normalizedEntries();
    const fonts = new Map<string, Map<number, string> | null>();
    const fontDict = Resources?.lookup(PDFName.of('Font'), PDFDict);
    for (const [name, ref] of fontDict?.entries() ?? []) {
      const dict = ref instanceof PDFRef ? doc.context.lookup(ref, PDFDict) : (ref as PDFDict);
      const toUnicode = dict.lookup(PDFName.of('ToUnicode'));
      fonts.set(
        name.decodeText(),
        toUnicode instanceof PDFRawStream ? parseCMap(streamText(toUnicode)) : null,
      );
    }
    const streams =
      Contents instanceof PDFArray
        ? Contents.asArray().map((r) => doc.context.lookup(r))
        : [Contents];
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue;
      const content = streamText(stream);
      let current: Map<number, string> | null = null;
      for (const m of content.matchAll(/\/(\S+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj/g)) {
        if (m[1] !== undefined) {
          current = fonts.get(m[1]) ?? null;
        } else if (current) {
          const hex = m[2]!;
          let text = '';
          for (let i = 0; i < hex.length; i += 4)
            text += current.get(parseInt(hex.slice(i, i + 4), 16)) ?? '�';
          out.push(text);
        } else {
          out.push(Buffer.from(m[2]!, 'hex').toString('latin1'));
        }
      }
    }
  }
  return out;
}
