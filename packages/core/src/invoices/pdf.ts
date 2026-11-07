import type { InvoiceType, PartySnapshot, TaxBreakdownEntry } from '@tix/shared';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { formatDate, formatMoney, formatPercent } from '../format';
import type { MailTranslator } from '../i18n/mail-messages';
import { toWinAnsi } from './pdf-text';

/**
 * Fixed, clean A4 invoice layout (DIN 5008-like address window, item table with automatic
 * page breaks, totals with tax breakdown, legal notes, seller footer on every page).
 * Rendering is deterministic for the same input (metadata dates = issue date), so a
 * re-rendered PDF is identical to the archived one. The visual designer follows later.
 */

export interface InvoicePdfLine {
  position: number;
  description: string;
  serviceDate: Date | null;
  quantity: number;
  unitPriceGross: number;
  taxRateBasisPoints: number;
  totalGross: number;
}

export interface InvoicePdfInput {
  type: InvoiceType;
  invoiceNumber: string;
  issuedAt: Date;
  correctsInvoiceNumber: string | null;
  currency: string;
  seller: PartySnapshot;
  buyer: PartySnapshot;
  orderNumber: string;
  orderDate: Date;
  paymentMethodLabel: string;
  lines: InvoicePdfLine[];
  totalNet: number;
  totalTax: number;
  totalGross: number;
  taxBreakdown: TaxBreakdownEntry[];
  legalNotes: string | null;
  /** Free text from the invoicing settings (bank details, greeting …). */
  footerText: string | null;
  locale: string;
  timeZone: string;
}

const MM = 72 / 25.4;
const PAGE: [number, number] = [210 * MM, 297 * MM];
const LEFT = 20 * MM;
const RIGHT = PAGE[0] - 20 * MM;
const WIDTH = RIGHT - LEFT;
const TOP = PAGE[1] - 15 * MM;

const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.38, 0.38, 0.42);
const RULE = rgb(0.82, 0.82, 0.85);
const HEADER_FILL = rgb(0.95, 0.95, 0.96);

/** Table columns (x = left edge, right-aligned columns are drawn at x + width). */
const COLS = (() => {
  const pos = 22;
  const qty = 36;
  const unit = 68;
  const vat = 40;
  const amount = 72;
  const desc = WIDTH - pos - qty - unit - vat - amount;
  let x = LEFT;
  const col = (width: number) => {
    const c = { x, width };
    x += width;
    return c;
  };
  return {
    pos: col(pos),
    desc: col(desc),
    qty: col(qty),
    unit: col(unit),
    vat: col(vat),
    amount: col(amount),
  };
})();

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface TextOptions {
  size?: number;
  font?: PDFFont;
  color?: RGB;
  align?: 'left' | 'right';
}

class Canvas {
  page!: PDFPage;
  y = TOP;
  readonly pages: PDFPage[] = [];

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Fonts,
    readonly contentBottom: number,
  ) {}

  addPage(): void {
    this.page = this.doc.addPage(PAGE);
    this.pages.push(this.page);
    this.y = TOP;
  }

  text(value: string, x: number, y: number, options: TextOptions = {}): void {
    const font = options.font ?? this.fonts.regular;
    const size = options.size ?? 9;
    const text = toWinAnsi(value);
    const width = font.widthOfTextAtSize(text, size);
    this.page.drawText(text, {
      x: options.align === 'right' ? x - width : x,
      y,
      size,
      font,
      color: options.color ?? INK,
    });
  }

  rule(y: number, x1 = LEFT, x2 = RIGHT, thickness = 0.6, color = RULE): void {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  /** Word-wrapped lines (explicit newlines kept, over-long words split). */
  wrap(value: string, maxWidth: number, size = 9, font = this.fonts.regular): string[] {
    const out: string[] = [];
    for (const paragraph of toWinAnsi(value).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/ +/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line) out.push(line);
        line = word;
        while (font.widthOfTextAtSize(line, size) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth) cut -= 1;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      out.push(line);
    }
    return out;
  }

  /** Ensures `height` points fit above the footer; otherwise starts a new page. */
  ensure(height: number, onNewPage?: () => void): void {
    if (this.y - height >= this.contentBottom) return;
    this.addPage();
    onNewPage?.();
  }
}

function addressLines(party: PartySnapshot, sellerCountry: string | undefined): string[] {
  const lines = [party.company, party.name].filter((l): l is string => Boolean(l));
  if (party.company && party.company === party.name) lines.shift();
  const a = party.address;
  if (a) {
    lines.push(a.street);
    if (a.addressLine2) lines.push(a.addressLine2);
    lines.push(`${a.postalCode} ${a.city}`);
    if (a.country && a.country !== sellerCountry) lines.push(a.country);
  } else if (party.email) {
    lines.push(party.email);
  }
  return lines;
}

function footerColumns(seller: PartySnapshot, t: MailTranslator): string[][] {
  const a = seller.address;
  const col1 = [seller.name, a?.street, a ? `${a.postalCode} ${a.city}` : undefined];
  const col2 = [
    seller.email,
    seller.vatId ? `${t('invoice.vatId')}: ${seller.vatId}` : undefined,
    seller.taxNumber ? `${t('invoice.taxNumber')}: ${seller.taxNumber}` : undefined,
  ];
  const col3 = [
    seller.registerCourt || seller.registerNumber
      ? `${t('invoice.register')}: ${[seller.registerCourt, seller.registerNumber].filter(Boolean).join(' ')}`
      : undefined,
    seller.representatives
      ? `${t('invoice.representatives')}: ${seller.representatives}`
      : undefined,
  ];
  return [col1, col2, col3].map((c) => c.filter((l): l is string => Boolean(l)));
}

export async function renderInvoicePdfDocument(
  input: InvoicePdfInput,
  t: MailTranslator,
): Promise<Uint8Array> {
  const { locale, timeZone } = input;
  const money = (cents: number) => formatMoney(cents, input.currency, locale);
  const date = (d: Date) => formatDate(d, locale, timeZone, 'medium');
  const isCredit = input.type === 'CREDIT_NOTE';

  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const title = isCredit ? t('invoice.creditNoteTitle') : t('invoice.title');
  doc.setTitle(toWinAnsi(`${title} ${input.invoiceNumber}`));
  doc.setAuthor(toWinAnsi(input.seller.name));
  doc.setSubject(toWinAnsi(`${t('invoice.orderNumber')} ${input.orderNumber}`));
  doc.setProducer('tix-platform');
  doc.setCreator('tix-platform');
  doc.setLanguage(locale);
  doc.setCreationDate(input.issuedAt);
  doc.setModificationDate(input.issuedAt);

  // Footer geometry first: the content area ends above it on every page.
  const FOOTER_SIZE = 7;
  const FOOTER_LEAD = 9;
  const probe = new Canvas(doc, fonts, 0);
  const colWidth = WIDTH / 3;
  // Footer columns, each line wrapped to the column width.
  const columns = footerColumns(input.seller, t).map((column) =>
    column.flatMap((line) => probe.wrap(line, colWidth - 6, FOOTER_SIZE)),
  );
  const footerTextLines = input.footerText?.trim()
    ? probe.wrap(input.footerText.trim(), WIDTH, FOOTER_SIZE)
    : [];
  const footerBlock =
    (footerTextLines.length + Math.max(...columns.map((c) => c.length), 0)) * FOOTER_LEAD +
    (footerTextLines.length ? 4 : 0);
  const footerTop = 12 * MM + footerBlock + 6;
  const canvas = new Canvas(doc, fonts, footerTop + 8);
  canvas.addPage();

  // ── Letterhead ──────────────────────────────────────────────────────────
  canvas.text(input.seller.name, LEFT, canvas.y - 4, { size: 14, font: fonts.bold });
  canvas.text(title, RIGHT, canvas.y - 4, { size: 18, font: fonts.bold, align: 'right' });
  const sellerAddress = input.seller.address
    ? [
        input.seller.address.street,
        `${input.seller.address.postalCode} ${input.seller.address.city}`,
      ]
    : [];
  const senderLine = [input.seller.name, ...sellerAddress].join(' · ');
  if (sellerAddress.length) {
    canvas.text(sellerAddress.join(' · '), LEFT, canvas.y - 20, { size: 9, color: MUTED });
  }

  // ── Address window (DIN 5008: 45 mm from the top) + info block ───────────
  const windowTop = PAGE[1] - 45 * MM;
  canvas.text(senderLine, LEFT, windowTop, { size: 7, color: MUTED });
  canvas.rule(windowTop - 2.5, LEFT, LEFT + 85 * MM, 0.4);
  let y = windowTop - 16;
  for (const line of addressLines(input.buyer, input.seller.address?.country)) {
    canvas.text(line, LEFT, y, { size: 10 });
    y -= 13;
  }
  const info: [string, string][] = [
    [isCredit ? t('invoice.creditNoteNumber') : t('invoice.number'), input.invoiceNumber],
    [t('invoice.date'), date(input.issuedAt)],
  ];
  if (input.correctsInvoiceNumber) info.push([t('invoice.corrects'), input.correctsInvoiceNumber]);
  info.push(
    [t('invoice.orderNumber'), input.orderNumber],
    [t('invoice.orderDate'), date(input.orderDate)],
    [t('invoice.paymentMethod'), input.paymentMethodLabel],
  );
  if (input.buyer.address && input.buyer.email) {
    info.push([t('invoice.customerEmail'), input.buyer.email]);
  }
  let infoY = windowTop;
  const infoX = LEFT + 105 * MM;
  for (const [label, value] of info) {
    canvas.text(label, infoX, infoY, { size: 9, color: MUTED });
    canvas.text(value, RIGHT, infoY, { size: 9, align: 'right' });
    infoY -= 13;
  }

  // ── Heading + intro ─────────────────────────────────────────────────────
  canvas.y = Math.min(y, infoY, PAGE[1] - 95 * MM) - 18;
  canvas.text(
    isCredit
      ? t('invoice.creditNoteHeading', { number: input.invoiceNumber })
      : t('invoice.heading', { number: input.invoiceNumber }),
    LEFT,
    canvas.y,
    { size: 13, font: fonts.bold },
  );
  canvas.y -= 18;
  for (const line of canvas.wrap(
    isCredit ? t('invoice.creditNoteIntro') : t('invoice.intro'),
    WIDTH,
    10,
  )) {
    canvas.text(line, LEFT, canvas.y, { size: 10 });
    canvas.y -= 13;
  }
  canvas.y -= 6;

  // ── Item table ──────────────────────────────────────────────────────────
  const tableHeader = () => {
    const h = 16;
    canvas.page.drawRectangle({
      x: LEFT,
      y: canvas.y - h + 4,
      width: WIDTH,
      height: h,
      color: HEADER_FILL,
    });
    const ty = canvas.y - 7;
    const head = { size: 8.5, font: fonts.bold };
    canvas.text(t('invoice.position'), COLS.pos.x + 2, ty, head);
    canvas.text(t('invoice.description'), COLS.desc.x, ty, head);
    canvas.text(t('invoice.quantity'), COLS.qty.x + COLS.qty.width, ty, {
      ...head,
      align: 'right',
    });
    canvas.text(t('invoice.unitPrice'), COLS.unit.x + COLS.unit.width, ty, {
      ...head,
      align: 'right',
    });
    canvas.text(t('invoice.taxRate'), COLS.vat.x + COLS.vat.width, ty, { ...head, align: 'right' });
    canvas.text(t('invoice.amount'), RIGHT, ty, { ...head, align: 'right' });
    canvas.y -= h + 4;
  };
  tableHeader();

  for (const line of input.lines) {
    const descLines = canvas.wrap(line.description, COLS.desc.width - 8, 9);
    const extra = line.serviceDate ? 1 : 0;
    const height = descLines.length * 11 + extra * 10 + 6;
    canvas.ensure(height, tableHeader);
    const top = canvas.y;
    canvas.text(String(line.position), COLS.pos.x + 2, top);
    descLines.forEach((text, i) =>
      canvas.text(text, COLS.desc.x, top - i * 11, i === 0 ? { font: fonts.bold } : {}),
    );
    if (line.serviceDate) {
      canvas.text(
        t('invoice.serviceDate', { date: date(line.serviceDate) }),
        COLS.desc.x,
        top - descLines.length * 11,
        { size: 8, color: MUTED },
      );
    }
    canvas.text(String(line.quantity), COLS.qty.x + COLS.qty.width, top, { align: 'right' });
    canvas.text(money(line.unitPriceGross), COLS.unit.x + COLS.unit.width, top, { align: 'right' });
    canvas.text(formatPercent(line.taxRateBasisPoints, locale), COLS.vat.x + COLS.vat.width, top, {
      align: 'right',
    });
    canvas.text(money(line.totalGross), RIGHT, top, { align: 'right' });
    canvas.y -= height;
    canvas.rule(canvas.y + 8);
  }

  // ── Totals ──────────────────────────────────────────────────────────────
  const totalsX = LEFT + 95 * MM;
  const totals: [string, string, boolean][] = [
    [t('invoice.net'), money(input.totalNet), false],
    ...input.taxBreakdown.map(
      (entry) =>
        [
          t('invoice.taxLine', {
            rate: formatPercent(entry.rateBasisPoints, locale),
            net: money(entry.net),
          }),
          money(entry.tax),
          false,
        ] as [string, string, boolean],
    ),
    [t('invoice.gross'), money(input.totalGross), true],
  ];
  canvas.ensure(totals.length * 14 + 16);
  canvas.y -= 6;
  for (const [label, value, strong] of totals) {
    if (strong) {
      canvas.y -= 4;
      canvas.rule(canvas.y + 12, totalsX, RIGHT, 0.9, INK);
    }
    const style = strong ? { size: 10.5, font: fonts.bold } : { size: 9 };
    canvas.text(label, totalsX, canvas.y, style);
    canvas.text(value, RIGHT, canvas.y, { ...style, align: 'right' });
    canvas.y -= strong ? 16 : 13;
  }

  // ── Legal notes ─────────────────────────────────────────────────────────
  const notes = (input.legalNotes ?? '').split('\n').filter((n) => n.trim());
  if (notes.length) {
    canvas.y -= 10;
    for (const note of notes) {
      const wrapped = canvas.wrap(note, WIDTH, 8.5);
      canvas.ensure(wrapped.length * 11 + 2);
      for (const line of wrapped) {
        canvas.text(line, LEFT, canvas.y, { size: 8.5, color: MUTED });
        canvas.y -= 11;
      }
      canvas.y -= 2;
    }
  }

  // ── Footer + page numbers on every page ─────────────────────────────────
  const pages = canvas.pages.length;
  canvas.pages.forEach((page, index) => {
    canvas.page = page;
    canvas.rule(footerTop, LEFT, RIGHT, 0.5);
    let fy = footerTop - 10;
    for (const line of footerTextLines) {
      canvas.text(line, LEFT, fy, { size: FOOTER_SIZE, color: MUTED });
      fy -= FOOTER_LEAD;
    }
    if (footerTextLines.length) fy -= 4;
    columns.forEach((column, c) => {
      column.forEach((line, i) => {
        canvas.text(line, LEFT + c * colWidth, fy - i * FOOTER_LEAD, {
          size: FOOTER_SIZE,
          color: MUTED,
        });
      });
    });
    canvas.text(t('invoice.page', { page: index + 1, pages }), RIGHT, 10 * MM, {
      size: 7.5,
      color: MUTED,
      align: 'right',
    });
  });

  return doc.save({ useObjectStreams: false });
}
