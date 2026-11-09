/**
 * Bundled Noto Sans: non-Latin-1 names must print as real characters in invoices and tickets.
 */
import { defaultTicketLayout } from '@tix/shared';
import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { mailTranslator, renderInvoicePdfDocument, type InvoicePdfInput } from '../src';
import { embedPdfFonts, loadBundledFontBytes, toPdfText } from '../src/pdf/fonts';
import { TicketPdfResources, renderTicketPage, type TicketRenderData } from '../src/tickets/pdf';
import { extractPdfText } from './pdf-extract';

const NAMES = ['Łukasz Żółć', 'Ελένη', 'Дмитрий', 'İpek Şahin', 'Dvořák Čapek'];

const invoice = (buyerName: string): InvoicePdfInput => ({
  type: 'INVOICE',
  invoiceNumber: 'RE-2026-000001',
  issuedAt: new Date('2026-11-05T10:00:00Z'),
  correctsInvoiceNumber: null,
  currency: 'EUR',
  seller: { name: 'Example Theatre e.V.' },
  buyer: { name: buyerName, email: 'buyer@example.org' },
  orderNumber: '2026-000001',
  orderDate: new Date('2026-11-01T09:00:00Z'),
  paymentMethodLabel: 'PayPal',
  lines: [
    {
      position: 1,
      description: `Winterkonzert für ${buyerName}`,
      serviceDate: null,
      quantity: 1,
      unitPriceGross: 3210,
      taxRateBasisPoints: 700,
      totalGross: 3210,
    },
  ],
  totalNet: 3000,
  totalTax: 210,
  totalGross: 3210,
  taxBreakdown: [{ rateBasisPoints: 700, net: 3000, tax: 210, gross: 3210 }],
  legalNotes: null,
  footerText: null,
  locale: 'de',
  timeZone: 'Europe/Berlin',
});

const ticket = (buyerName: string): TicketRenderData => ({
  locale: 'de',
  timeZone: 'Europe/Berlin',
  eventTitle: 'Das Phantom der Oper',
  eventSubtitle: null,
  startsAt: new Date('2026-12-05T18:30:00Z'),
  doorsOpenAt: null,
  venueName: 'Stadthalle',
  venueAddress: null,
  kind: 'SEAT',
  sectionLabel: 'Parkett',
  rowLabel: '5',
  seatLabel: '12',
  entranceLabel: null,
  priceCategory: 'Kategorie 1',
  ticketType: 'Normal',
  priceGross: 3500,
  currency: 'EUR',
  buyerName,
  attendeeName: buyerName,
  orderNumber: 'T-2026-1',
  ticketCode: 'ABCDE-FGHJK',
  organizerName: 'Verein',
  qrPayload: 'tix://v1/k1.a.b.c.d',
});

describe('bundled PDF font', () => {
  it('finds the Noto Sans files', async () => {
    const bytes = await loadBundledFontBytes();
    expect(bytes).not.toBeNull();
    expect(bytes!.regular.byteLength).toBeGreaterThan(100_000);
    expect(bytes!.bold.byteLength).toBeGreaterThan(100_000);
  });

  it('embeds subsets so PDFs stay small', async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedPdfFonts(doc);
    expect(fonts.unicode).toBe(true);
    const page = doc.addPage();
    page.drawText('Łukasz Дмитрий Ελένη', { font: fonts.regular, size: 12 });
    const bytes = await doc.save();
    expect(bytes.byteLength).toBeLessThan(60_000);
  });

  it('replaces glyphs missing in the font by "?"', async () => {
    const doc = await PDFDocument.create();
    const { regular } = await embedPdfFonts(doc);
    expect(toPdfText('Łukasz Дмитрий Ελένη', regular)).toBe('Łukasz Дмитрий Ελένη');
    expect(toPdfText('Tokyo 東京', regular)).toBe('Tokyo ??');
    expect(toPdfText('a\u0007b\tc', regular)).toBe('ab c');
  });

  it.each(NAMES)('prints "%s" on invoices', async (name) => {
    const bytes = await renderInvoicePdfDocument(invoice(name), mailTranslator('de'));
    const texts = await extractPdfText(bytes);
    expect(texts).toContain(name);
    expect(texts).toContain(`Winterkonzert für ${name}`);
    expect(texts.join('\n')).not.toContain('?');
    expect(texts.join('\n')).not.toContain('�');
  });

  it.each(NAMES)('prints "%s" on tickets', async (name) => {
    const doc = await PDFDocument.create();
    const res = new TicketPdfResources(doc);
    await renderTicketPage(
      res,
      { pageWidthMm: 200, pageHeightMm: 125, layout: defaultTicketLayout() },
      ticket(name),
    );
    const texts = await extractPdfText(await doc.save({ useObjectStreams: false }));
    expect(texts.some((t) => t.includes(name))).toBe(true);
    expect(texts.join('\n')).not.toContain('?');
  });
});

/** Embedded TrueType programs (FontFile2) of a PDF, decoded. */
async function embeddedFontPrograms(bytes: Uint8Array): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const programs: Uint8Array[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const ref = obj.get(PDFName.of('FontFile2'));
    if (!(ref instanceof PDFRef)) continue;
    const stream = doc.context.lookup(ref);
    if (stream instanceof PDFRawStream) programs.push(decodePDFRawStream(stream).decode());
  }
  return programs;
}

const outline = (glyph: { path: { toSVG(): string } }) => glyph.path.toSVG();

/**
 * Glyph-presence check: every printable character of `text` must exist in an embedded font
 * program with exactly the outline of the bundled font. A text layer (ToUnicode) can be complete
 * while the glyph outlines are damaged, in which case the characters are invisible on screen.
 */
async function expectGlyphsPresent(pdf: Uint8Array, text: string, ...bundled: Uint8Array[]) {
  const originals = bundled.map(
    (b) =>
      fontkit.create(b as Buffer) as unknown as {
        glyphForCodePoint(cp: number): { path: { toSVG(): string } };
      },
  );
  const programs = await embeddedFontPrograms(pdf);
  expect(programs.length).toBeGreaterThan(0);
  const subsetOutlines = new Set<string>();
  for (const program of programs) {
    const subset = fontkit.create(program as Buffer) as unknown as {
      numGlyphs: number;
      getGlyph(id: number): { path: { toSVG(): string } };
    };
    for (let gid = 0; gid < subset.numGlyphs; gid += 1) {
      subsetOutlines.add(outline(subset.getGlyph(gid)));
    }
  }
  const missing: string[] = [];
  for (const char of new Set([...text])) {
    if (/\s/u.test(char)) continue;
    const found = originals.some((original) => {
      const expected = outline(original.glyphForCodePoint(char.codePointAt(0)!));
      return expected !== '' && subsetOutlines.has(expected);
    });
    if (!found) missing.push(char);
  }
  expect(missing).toEqual([]);
}

const GLYPH_TEXT = [
  'Tickets für 22.05.2027 – 19 Uhr',
  'Bürgerhaus Bischofsheim',
  'Reihe 13 · Platz 291',
  'PK3 · Normalpreis RPKQF-Z0X3Q Bestellung 2026-000004',
  'Łukasz Żółć Ελένη Дмитрий İpek Şahin Dvořák Čapek',
  '0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ ÄÖÜäöüß €',
].join(' ');

describe('embedded font glyphs', () => {
  it('bundled font files keep glyph data even-aligned (fontkit subsets need it)', async () => {
    // fontkit writes short-format `loca` tables and silently drops the last byte of every
    // odd-length glyph, which corrupts the outline; the bundled files are therefore re-packed
    // with 4-byte glyph padding (see assets/fonts/README.md).
    const bytes = (await loadBundledFontBytes())!;
    for (const data of [bytes.regular, bytes.bold]) {
      const font = fontkit.create(data as Buffer) as unknown as {
        loca: { offsets: number[] };
      };
      const odd = font.loca.offsets.filter((o, i, all) => i > 0 && (o - all[i - 1]!) % 2 !== 0);
      expect(odd).toEqual([]);
    }
  });

  it('keeps all glyph outlines in a ticket PDF (regular + bold)', async () => {
    const bytes = (await loadBundledFontBytes())!;
    const doc = await PDFDocument.create();
    const res = new TicketPdfResources(doc);
    await renderTicketPage(
      res,
      { pageWidthMm: 200, pageHeightMm: 125, layout: defaultTicketLayout() },
      {
        ...ticket('Łukasz Żółć'),
        eventTitle: 'Tickets für 22.05.2027 – 19 Uhr',
        venueName: 'Bürgerhaus Bischofsheim',
        rowLabel: '13',
        seatLabel: '291',
        sectionLabel: '',
        priceCategory: 'PK3',
        ticketType: 'Normalpreis',
        ticketCode: 'RPKQF-Z0X3Q',
        orderNumber: '2026-000004',
      },
    );
    const out = await doc.save({ useObjectStreams: false });
    const drawn = (await extractPdfText(out)).join(' ');
    expect(drawn).toContain('Bürgerhaus Bischofsheim');
    await expectGlyphsPresent(out, drawn, bytes.regular, bytes.bold);
  });

  it('keeps all glyph outlines when drawing the full test alphabet', async () => {
    const bytes = (await loadBundledFontBytes())!;
    for (const key of ['regular', 'bold'] as const) {
      const doc = await PDFDocument.create();
      const fonts = await embedPdfFonts(doc);
      const page = doc.addPage();
      page.drawText(toPdfText(GLYPH_TEXT, fonts[key]), {
        font: fonts[key],
        size: 8,
      });
      await expectGlyphsPresent(
        await doc.save({ useObjectStreams: false }),
        GLYPH_TEXT,
        bytes[key],
      );
    }
  });

  it('keeps all glyph outlines in an invoice PDF', async () => {
    const bytes = (await loadBundledFontBytes())!;
    const out = await renderInvoicePdfDocument(
      invoice('Łukasz Żółć Ελένη Дмитрий'),
      mailTranslator('de'),
    );
    const drawn = (await extractPdfText(out)).join(' ');
    expect(drawn).toContain('Winterkonzert für Łukasz Żółć Ελένη Дмитрий');
    await expectGlyphsPresent(out, drawn, bytes.regular, bytes.bold);
  });
});
