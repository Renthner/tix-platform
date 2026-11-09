/**
 * Ticket page renderer without a database: page size, text fitting, field values, hidden
 * block label, QR matrix (decoded back with jsQR) and layout schema compatibility.
 */
import {
  DEFAULT_TICKET_PAGE_MM,
  defaultTicketDesign,
  defaultTicketLayout,
  ticketLayoutSchema,
  type TicketLayout,
} from '@tix/shared';
import jsQR from 'jsqr';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { extractPdfText } from './pdf-extract';
import {
  MM,
  TicketPdfResources,
  elementText,
  fitText,
  renderTicketPage,
  ticketQrMatrix,
  type TicketRenderData,
} from '../src/tickets/pdf';

const PAYLOAD =
  'tix://v1/k1.AAAAAAAAQACAAAAAAAAAAQ.AAAAAAAAQACAAAAAAAAAAg.UGFya2V0dHxSNXwxMg.rtTDrMv6GaEmTIQMvUPkOC7LGLnEOSzp816oE6eIZdLaTuccet2SFH1H-UxDjs-uXuucamvw30cb6SeM4bMkBA';

const data = (patch: Partial<TicketRenderData> = {}): TicketRenderData => ({
  locale: 'de',
  timeZone: 'Europe/Berlin',
  eventTitle: 'Das Phantom der Oper',
  eventSubtitle: null,
  startsAt: new Date('2026-12-05T18:30:00Z'),
  doorsOpenAt: new Date('2026-12-05T17:30:00Z'),
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
  buyerName: 'Anna Beispiel',
  attendeeName: null,
  orderNumber: 'T-2026-1',
  ticketCode: 'ABCDE-FGHJK',
  organizerName: 'Verein',
  qrPayload: PAYLOAD,
  ...patch,
});

const drawnText = extractPdfText;

async function render(
  layout: TicketLayout,
  size: { w: number; h: number },
  d = data(),
): Promise<{ bytes: Uint8Array; doc: PDFDocument }> {
  const doc = await PDFDocument.create();
  const res = new TicketPdfResources(doc);
  await renderTicketPage(res, { pageWidthMm: size.w, pageHeightMm: size.h, layout }, d, {
    coverPlaceholder: true,
  });
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, doc };
}

describe('ticket page renderer', () => {
  it('creates a page of the template size in mm', async () => {
    const { doc } = await render(defaultTicketLayout(), { w: 200, h: 125 });
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeCloseTo(200 * MM, 3);
    expect(page.getHeight()).toBeCloseTo(125 * MM, 3);
    const other = await render(defaultTicketLayout(), { w: 148, h: 105 });
    expect(other.doc.getPage(0).getWidth()).toBeCloseTo(148 * MM, 3);
  });

  it('prints localized values in the event time zone', async () => {
    const { bytes } = await render(defaultTicketLayout(), { w: 200, h: 125 });
    const texts = await drawnText(bytes);
    expect(texts).toContain('Das Phantom der Oper');
    expect(texts.some((t) => t.includes('5. Dezember 2026'))).toBe(true);
    expect(texts).toContain('19:30'); // 18:30Z = 19:30 in Berlin (CET)
    expect(texts).toContain('Block Parkett · Reihe 5 · Platz 12');
    expect(texts).toContain('Einlass'.toLocaleUpperCase('de'));
    expect(texts.join('\n')).not.toContain('tix://');
  });

  it('hides the block label when show_label_on_ticket is off (empty section label)', async () => {
    const { bytes } = await render(
      defaultTicketLayout(),
      { w: 200, h: 125 },
      data({ sectionLabel: '' }),
    );
    const texts = await drawnText(bytes);
    expect(texts).toContain('Reihe 5 · Platz 12');
    expect(texts.join('\n')).not.toContain('Parkett');
    const standing = await render(
      defaultTicketLayout(),
      { w: 200, h: 125 },
      data({ kind: 'GENERAL_ADMISSION', sectionLabel: '', rowLabel: null, seatLabel: null }),
    );
    expect(await drawnText(standing.bytes)).toContain('Stehplatz');
  });

  it('prints Latin Extended text and replaces glyphs missing in the font instead of failing', async () => {
    const { bytes } = await render(
      defaultTicketLayout(),
      { w: 200, h: 125 },
      data({ eventTitle: 'Łódź – Žižek ✓ 日本' }),
    );
    expect((await drawnText(bytes)).some((t) => t.startsWith('Łódź – Žižek '))).toBe(true);
  });

  it('draws one page per call and never prints the QR payload as text', async () => {
    const doc = await PDFDocument.create();
    const res = new TicketPdfResources(doc);
    for (let n = 0; n < 3; n += 1) {
      await renderTicketPage(
        res,
        { pageWidthMm: 200, pageHeightMm: 125, layout: defaultTicketLayout() },
        data({ seatLabel: String(n + 1) }),
      );
    }
    expect(doc.getPageCount()).toBe(3);
    expect((await drawnText(await doc.save())).join('')).not.toContain('tix://');
  });
});

describe('text fitting', () => {
  it('shrinks long single-line text to fit the box width', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const box = { w: 60 * MM, h: 9 * MM };
    const fitted = fitText('Eine ziemlich lange Veranstaltungsbezeichnung', font, 18, box.w, box.h);
    expect(fitted.size).toBeLessThan(18);
    for (const line of fitted.lines) {
      expect(font.widthOfTextAtSize(line, fitted.size)).toBeLessThanOrEqual(box.w + 0.01);
    }
    expect(fitted.lines.length * fitted.size * 1.2).toBeLessThanOrEqual(box.h + 0.01);
  });

  it('wraps into several lines when the box is tall enough and cuts with an ellipsis otherwise', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const wrapped = fitText('alpha beta gamma delta epsilon zeta eta theta', font, 10, 60, 60);
    expect(wrapped.lines.length).toBeGreaterThan(1);
    const huge = 'wort '.repeat(300);
    const cut = fitText(huge, font, 10, 80, 20);
    expect(cut.size).toBeGreaterThanOrEqual(4);
    expect(cut.lines.at(-1)!.endsWith('...')).toBe(true);
  });

  it('keeps short text at the configured size', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(fitText('A', font, 12, 100, 20).size).toBe(12);
  });
});

describe('field values and layout schema', () => {
  it('substitutes placeholders and labels in static texts', () => {
    const element = ticketLayoutSchema.parse({
      version: 1,
      qr: { x: 0, y: 0, size: 30 },
      elements: [
        {
          kind: 'text',
          id: 't',
          field: 'STATIC_TEXT',
          text: '{{label.order}} {{orderNumber}} / {{unknown}} / {{seatFull}}',
          x: 0,
          y: 0,
          width: 50,
          height: 5,
        },
      ],
    }).elements[0]!;
    if (element.kind !== 'text') throw new Error('text expected');
    expect(elementText(element, data({ locale: 'en' }))).toBe(
      'Order T-2026-1 /  / Block Parkett · Row 5 · Seat 12',
    );
  });

  it('accepts layouts saved before the cover element existed', () => {
    const legacy = {
      version: 1,
      qr: { x: 10, y: 10, size: 30 },
      elements: [
        { kind: 'shape', id: 's', shape: 'rect', x: 0, y: 0, width: 5, height: 5 },
        { kind: 'text', id: 't', field: 'EVENT_TITLE', x: 0, y: 0, width: 50, height: 5 },
      ],
    };
    expect(ticketLayoutSchema.safeParse(legacy).success).toBe(true);
    expect(ticketLayoutSchema.safeParse(defaultTicketLayout()).success).toBe(true);
  });
});

describe('built-in design', () => {
  it('has a 16:9 cover band at the page width and every element inside the page', () => {
    const { pageWidthMm, pageHeightMm, layout } = defaultTicketDesign();
    expect({ width: pageWidthMm, height: pageHeightMm }).toEqual(DEFAULT_TICKET_PAGE_MM);
    const cover = layout.elements.find((e) => e.kind === 'cover')!;
    expect(cover.width).toBe(pageWidthMm);
    expect(cover.width / cover.height).toBeCloseTo(16 / 9, 1);
    for (const e of layout.elements) {
      expect(e.x + e.width).toBeLessThanOrEqual(pageWidthMm + 0.01);
      expect(e.y + e.height).toBeLessThanOrEqual(pageHeightMm + 0.01);
    }
    expect(layout.qr.x + layout.qr.size).toBeLessThanOrEqual(pageWidthMm);
    expect(layout.qr.y + layout.qr.size).toBeLessThanOrEqual(pageHeightMm);
    // a wider cover gives a flatter band and a shorter page
    expect(defaultTicketDesign(21 / 9).pageHeightMm).toBeLessThan(pageHeightMm);
  });
});

describe('QR code', () => {
  it('decodes back to the exact signed payload for every error-correction level', () => {
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      const matrix = ticketQrMatrix(PAYLOAD, level);
      const quiet = 4;
      const scale = 4;
      const size = (matrix.length + 2 * quiet) * scale;
      const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
      matrix.forEach((cells, r) =>
        cells.forEach((dark, c) => {
          if (!dark) return;
          for (let y = 0; y < scale; y += 1) {
            for (let x = 0; x < scale; x += 1) {
              const px = ((r + quiet) * scale + y) * size + (c + quiet) * scale + x;
              pixels[px * 4] = pixels[px * 4 + 1] = pixels[px * 4 + 2] = 0;
            }
          }
        }),
      );
      expect(jsQR(pixels, size, size)?.data).toBe(PAYLOAD);
    }
  });

  it('skips an unconvertible WebP image instead of failing', async () => {
    const doc = await PDFDocument.create();
    const res = new TicketPdfResources(doc);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const image = await res.image('bad-webp', async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/webp',
    }));
    expect(image).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
