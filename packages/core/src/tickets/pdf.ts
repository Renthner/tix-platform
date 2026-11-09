import {
  TICKET_FIELD_VARIABLES,
  TICKET_LABEL_KEYS,
  type TicketLayout,
  type TicketLayoutElement,
  type TicketTextElement,
} from '@tix/shared';
import {
  PDFDocument,
  clip,
  degrees,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import qrcode from 'qrcode-generator';
import { formatTime } from '../format';
import { mailTranslator, type MailTranslator } from '../i18n/mail-messages';
import { embedPdfFonts, toPdfText, type PdfFonts } from '../pdf/fonts';

/**
 * Ticket page renderer: draws one ticket of a template layout onto a page of a shared
 * pdf-lib document (one PDF per order = one page per ticket). Pure and deterministic: all
 * data comes in through `TicketRenderData`, images through `TicketPdfResources`.
 * The QR payload is only ever drawn as the QR code (never printed as text).
 */

export const MM = 72 / 25.4;

export interface TicketImageSource {
  bytes: Uint8Array;
  mimeType: string;
}

export interface TicketRenderData {
  locale: string;
  timeZone: string;
  eventTitle: string;
  eventSubtitle: string | null;
  startsAt: Date;
  doorsOpenAt: Date | null;
  venueName: string;
  venueAddress: string | null;
  kind: 'SEAT' | 'GENERAL_ADMISSION';
  /** Empty when the section's `show_label_on_ticket` is off. */
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
  entranceLabel: string | null;
  priceCategory: string;
  ticketType: string;
  /** Gross price in cents. */
  priceGross: number;
  currency: string;
  buyerName: string;
  attendeeName: string | null;
  orderNumber: string;
  /** Formatted `XXXXX-XXXXX`. */
  ticketCode: string;
  organizerName: string;
  qrPayload: string;
}

export interface TicketPageTemplate {
  pageWidthMm: number;
  pageHeightMm: number;
  layout: TicketLayout;
}

/** Fonts and images embedded once per document. */
export class TicketPdfResources {
  private readonly fonts = new Map<string, Promise<PDFFont>>();
  private unicodeFonts: Promise<PdfFonts> | undefined;
  private readonly images = new Map<string, Promise<PDFImage | null>>();

  constructor(readonly doc: PDFDocument) {}

  /**
   * Bundled Noto Sans (Regular/Bold) for every family: older layouts name Helvetica, Times or
   * Courier, which all print in the Unicode font now. Standard Helvetica only if the font files
   * are missing.
   */
  font(_family: string, bold: boolean): Promise<PDFFont> {
    const key = bold ? 'bold' : 'regular';
    let font = this.fonts.get(key);
    if (!font) {
      this.unicodeFonts ??= embedPdfFonts(this.doc);
      font = this.unicodeFonts.then((fonts) => fonts[key]);
      this.fonts.set(key, font);
    }
    return font;
  }

  /** Embeds (once per `key`) a PNG / JPEG; WebP is converted to PNG. Null if unusable. */
  image(key: string, load: () => Promise<TicketImageSource | null>): Promise<PDFImage | null> {
    let image = this.images.get(key);
    if (!image) {
      image = (async () => {
        try {
          const source = await load();
          return source ? await embedImage(this.doc, source) : null;
        } catch (err) {
          console.warn(`[tickets] image ${key} could not be embedded`, err);
          return null;
        }
      })();
      this.images.set(key, image);
    }
    return image;
  }
}

async function embedImage(doc: PDFDocument, source: TicketImageSource): Promise<PDFImage> {
  if (source.mimeType === 'image/png') return doc.embedPng(source.bytes);
  if (source.mimeType === 'image/jpeg') return doc.embedJpg(source.bytes);
  // WebP: pdf-lib cannot embed it, convert to PNG (sharp is loaded lazily). A missing or
  // failing sharp must not break the ticket: the caller logs a warning and skips the image.
  const { default: sharp } = await import('sharp');
  const png = await sharp(source.bytes).png().toBuffer();
  return doc.embedPng(png);
}

// ─── field values ───────────────────────────────────────────────────────────

const hex = (value: string) => {
  const n = Number.parseInt(value.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

function seatFull(data: TicketRenderData, t: MailTranslator): string {
  if (data.kind === 'GENERAL_ADMISSION' || !data.seatLabel) {
    return data.sectionLabel
      ? t('items.standing', { section: data.sectionLabel })
      : t('ticket.standing');
  }
  if (data.sectionLabel) {
    return data.rowLabel
      ? t('items.seat', { section: data.sectionLabel, row: data.rowLabel, seat: data.seatLabel })
      : t('items.seatWithoutRow', { section: data.sectionLabel, seat: data.seatLabel });
  }
  return data.rowLabel
    ? t('ticket.rowSeat', { row: data.rowLabel, seat: data.seatLabel })
    : t('ticket.seatOnly', { seat: data.seatLabel });
}

type DateStyle = 'short' | 'medium' | 'long' | 'full';

function dateValue(date: Date | null, data: TicketRenderData, style: DateStyle = 'long'): string {
  if (!date) return '';
  return new Intl.DateTimeFormat(data.locale, { dateStyle: style, timeZone: data.timeZone }).format(
    date,
  );
}

function timeValue(
  date: Date | null,
  data: TicketRenderData,
  style: 'short' | 'medium' = 'short',
): string {
  if (!date) return '';
  return style === 'short'
    ? formatTime(date, data.locale, data.timeZone)
    : new Intl.DateTimeFormat(data.locale, { timeStyle: 'medium', timeZone: data.timeZone }).format(
        date,
      );
}

/** Named values for `{{placeholders}}` of static texts (and the base of the field values). */
export function ticketVariables(
  data: TicketRenderData,
  element?: Pick<TicketTextElement, 'dateStyle' | 'timeStyle'>,
): Record<string, string> {
  const t = mailTranslator(data.locale);
  return {
    ...Object.fromEntries(TICKET_LABEL_KEYS.map((k) => [`label.${k}`, t(`ticket.${k}`)])),
    eventTitle: data.eventTitle,
    eventSubtitle: data.eventSubtitle ?? '',
    eventDate: dateValue(data.startsAt, data, element?.dateStyle),
    eventTime: timeValue(data.startsAt, data, element?.timeStyle),
    doorsTime: timeValue(data.doorsOpenAt, data, element?.timeStyle),
    venueName: data.venueName,
    venueAddress: data.venueAddress ?? '',
    section: data.sectionLabel,
    row: data.rowLabel ?? '',
    seat: data.seatLabel ?? '',
    seatFull: seatFull(data, t),
    entrance: data.entranceLabel ?? '',
    priceCategory: data.priceCategory,
    ticketType: data.ticketType,
    price: new Intl.NumberFormat(data.locale, {
      style: 'currency',
      currency: data.currency,
    }).format(data.priceGross / 100),
    buyerName: data.buyerName,
    attendeeName: data.attendeeName ?? data.buyerName,
    orderNumber: data.orderNumber,
    ticketCode: data.ticketCode,
    organizerName: data.organizerName,
  };
}

/** The text an element prints for this ticket (after upper-casing). */
export function elementText(element: TicketTextElement, data: TicketRenderData): string {
  const vars = ticketVariables(data, element);
  const raw =
    element.field === 'STATIC_TEXT'
      ? (element.text ?? '').replace(
          /\{\{\s*([\w.]+)\s*\}\}/g,
          (_m, name: string) => vars[name] ?? '',
        )
      : (vars[TICKET_FIELD_VARIABLES[element.field]] ?? '');
  return element.uppercase ? raw.toLocaleUpperCase(data.locale) : raw;
}

// ─── text fitting ───────────────────────────────────────────────────────────

const LINE_HEIGHT = 1.2;

function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      // A single word wider than the box: break it by characters.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      current = rest;
    }
    lines.push(current);
  }
  return lines;
}

function ellipsize(line: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(line, size) <= maxWidth) return line;
  let out = line;
  while (out.length > 0 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out.trimEnd()}...`;
}

export interface FittedText {
  size: number;
  lines: string[];
}

/**
 * Largest font size (down to 40 % of the configured size, at least 4 pt) at which the text
 * fits the box (width by wrapping, height by line count); at the minimum size an overflow is
 * cut with an ellipsis.
 */
export function fitText(
  text: string,
  font: PDFFont,
  fontSize: number,
  boxWidth: number,
  boxHeight: number,
): FittedText {
  const min = Math.min(fontSize, Math.max(4, fontSize * 0.4));
  for (let size = fontSize; size >= min - 1e-6; size -= 0.5) {
    const lines = wrapLines(text, font, size, boxWidth);
    if (lines.length * size * LINE_HEIGHT <= boxHeight + 0.01) return { size, lines };
  }
  const lines = wrapLines(text, font, min, boxWidth);
  const maxLines = Math.max(1, Math.floor(boxHeight / (min * LINE_HEIGHT)));
  const kept = lines.slice(0, maxLines);
  const last = kept.length - 1;
  kept[last] = ellipsize(
    lines.length > maxLines ? `${kept[last]} ${lines[maxLines]}` : (kept[last] ?? ''),
    font,
    min,
    boxWidth,
  );
  return { size: min, lines: kept };
}

// ─── drawing ────────────────────────────────────────────────────────────────

/** Maps a point of an element's local frame (pt, y down) to PDF page coordinates. */
function mapPoint(
  origin: { x: number; y: number },
  rotationDeg: number,
  pageHeight: number,
  u: number,
  v: number,
) {
  const a = (rotationDeg * Math.PI) / 180;
  const x = origin.x + u * Math.cos(a) - v * Math.sin(a);
  const y = origin.y + u * Math.sin(a) + v * Math.cos(a);
  return { x, y: pageHeight - y };
}

async function drawText(
  page: PDFPage,
  res: TicketPdfResources,
  element: TicketTextElement,
  data: TicketRenderData,
  pageHeight: number,
): Promise<void> {
  const font = await res.font(element.fontFamily, element.fontWeight === 'bold');
  const text = toPdfText(elementText(element, data), font).trim();
  if (!text) return;
  const width = element.width * MM;
  const height = element.height * MM;
  const fitted = fitText(text, font, element.fontSize, width, height);
  const origin = { x: element.x * MM, y: element.y * MM };
  const lineHeight = fitted.size * LINE_HEIGHT;
  fitted.lines.forEach((line, index) => {
    const lineWidth = font.widthOfTextAtSize(line, fitted.size);
    const u =
      element.align === 'center'
        ? (width - lineWidth) / 2
        : element.align === 'right'
          ? width - lineWidth
          : 0;
    // Baseline: top of the line box + half the leading + ascent share of the font size.
    const v = index * lineHeight + (lineHeight - fitted.size) / 2 + fitted.size * 0.8;
    const p = mapPoint(origin, element.rotation, pageHeight, u, v);
    page.drawText(line, {
      x: p.x,
      y: p.y,
      size: fitted.size,
      font,
      color: hex(element.color),
      rotate: degrees(-element.rotation),
    });
  });
}

/** Draws an image into a box; `cover` crops to fill, `contain` letterboxes. */
function drawImageInBox(
  page: PDFPage,
  image: PDFImage,
  box: { x: number; y: number; width: number; height: number },
  fit: 'cover' | 'contain',
  opacity: number,
  rotationDeg: number,
  pageHeight: number,
): void {
  const bw = box.width * MM;
  const bh = box.height * MM;
  const scale =
    fit === 'cover'
      ? Math.max(bw / image.width, bh / image.height)
      : Math.min(bw / image.width, bh / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  const origin = { x: box.x * MM, y: box.y * MM };
  // Lower-left corner of the (possibly cropped) image in page coordinates.
  const bottomLeft = mapPoint(origin, rotationDeg, pageHeight, (bw - w) / 2, (bh - h) / 2 + h);
  const clipped = fit === 'cover' && rotationDeg === 0;
  if (clipped) {
    const corner = mapPoint(origin, 0, pageHeight, 0, bh);
    page.pushOperators(
      pushGraphicsState(),
      rectangle(corner.x, corner.y, bw, bh),
      clip(),
      endPath(),
    );
  }
  page.drawImage(image, {
    x: bottomLeft.x,
    y: bottomLeft.y,
    width: w,
    height: h,
    rotate: degrees(-rotationDeg),
    opacity,
  });
  if (clipped) page.pushOperators(popGraphicsState());
}

/** QR module matrix (true = dark) of a payload; rows top to bottom. */
export function ticketQrMatrix(
  payload: string,
  errorCorrection: TicketLayout['qr']['errorCorrection'],
): boolean[][] {
  const code = qrcode(0, errorCorrection);
  code.addData(payload, 'Byte');
  code.make();
  const count = code.getModuleCount();
  return Array.from({ length: count }, (_row, r) =>
    Array.from({ length: count }, (_col, c) => code.isDark(r, c)),
  );
}

function drawQr(page: PDFPage, qr: TicketLayout['qr'], payload: string, pageHeight: number): void {
  const matrix = ticketQrMatrix(payload, qr.errorCorrection);
  const count = matrix.length;
  const total = count + 2 * qr.margin;
  const module = (qr.size * MM) / total;
  const left = qr.x * MM;
  const top = pageHeight - qr.y * MM;
  page.drawRectangle({
    x: left,
    y: top - qr.size * MM,
    width: qr.size * MM,
    height: qr.size * MM,
    color: hex(qr.background),
  });
  const dark = hex(qr.foreground);
  matrix.forEach((cells, row) => {
    let col = 0;
    while (col < count) {
      if (!cells[col]) {
        col += 1;
        continue;
      }
      let end = col;
      while (end + 1 < count && cells[end + 1]) end += 1;
      page.drawRectangle({
        x: left + (qr.margin + col) * module,
        y: top - (qr.margin + row + 1) * module,
        width: (end - col + 1) * module,
        height: module,
        color: dark,
      });
      col = end + 1;
    }
  });
}

export interface RenderTicketPageOptions {
  /** Loads the template background (ticket_templates.background_asset_id). */
  background?: () => Promise<TicketImageSource | null>;
  backgroundKey?: string;
  /** Loads the event cover for `cover` elements. */
  cover?: () => Promise<TicketImageSource | null>;
  coverKey?: string;
  /** Loads an `image` element's asset. */
  asset?: (assetId: string) => Promise<TicketImageSource | null>;
  /** Draw a grey placeholder where the cover goes when there is none (designer preview). */
  coverPlaceholder?: boolean;
}

/** Adds a page for one ticket. */
export async function renderTicketPage(
  res: TicketPdfResources,
  template: TicketPageTemplate,
  data: TicketRenderData,
  options: RenderTicketPageOptions = {},
): Promise<PDFPage> {
  const pageWidth = template.pageWidthMm * MM;
  const pageHeight = template.pageHeightMm * MM;
  const page = res.doc.addPage([pageWidth, pageHeight]);

  if (options.background) {
    const bg = await res.image(options.backgroundKey ?? 'background', options.background);
    if (bg) {
      drawImageInBox(
        page,
        bg,
        { x: 0, y: 0, width: template.pageWidthMm, height: template.pageHeightMm },
        'cover',
        1,
        0,
        pageHeight,
      );
    }
  }

  for (const element of template.layout.elements as TicketLayoutElement[]) {
    switch (element.kind) {
      case 'shape': {
        const x = element.x * MM;
        const y = pageHeight - (element.y + element.height) * MM;
        if (element.shape === 'rect') {
          page.drawRectangle({
            x,
            y,
            width: element.width * MM,
            height: element.height * MM,
            color: element.fill ? hex(element.fill) : undefined,
            borderColor: element.stroke ? hex(element.stroke) : undefined,
            borderWidth: element.stroke ? element.strokeWidth * MM : 0,
          });
        } else {
          page.drawLine({
            start: { x, y: pageHeight - element.y * MM },
            end: { x: x + element.width * MM, y },
            thickness: Math.max(0.1, element.strokeWidth * MM),
            color: hex(element.stroke ?? element.fill ?? '#000000'),
          });
        }
        break;
      }
      case 'image': {
        const loadAsset = options.asset;
        const image = loadAsset
          ? await res.image(`asset:${element.assetId}`, () => loadAsset(element.assetId))
          : null;
        if (image) {
          drawImageInBox(
            page,
            image,
            element,
            'contain',
            element.opacity,
            element.rotation,
            pageHeight,
          );
        }
        break;
      }
      case 'cover': {
        const image = options.cover
          ? await res.image(options.coverKey ?? 'cover', options.cover)
          : null;
        if (image) {
          drawImageInBox(page, image, element, element.fit, element.opacity, 0, pageHeight);
        } else if (options.coverPlaceholder) {
          page.drawRectangle({
            x: element.x * MM,
            y: pageHeight - (element.y + element.height) * MM,
            width: element.width * MM,
            height: element.height * MM,
            color: rgb(0.88, 0.89, 0.91),
          });
        }
        break;
      }
      case 'text':
        await drawText(page, res, element, data, pageHeight);
        break;
    }
  }

  drawQr(page, template.layout.qr, data.qrPayload, pageHeight);
  return page;
}
