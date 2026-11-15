import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { embedPdfFonts, toPdfText, type PdfFonts } from '../pdf/fonts';
import { formatReportTime, type GuestListLabels } from './csv';
import type { GuestListRow, Occupancy, OccupancyStatus } from './data';

/**
 * Multi-page A4 reports for door staff: the seating occupancy (portrait) and the guest list
 * (landscape). Noto Sans is embedded (names in any Latin/Greek/Cyrillic script). Layout is plain
 * and printable in black and white: sold = filled, reserved = grey, blocked = crossed, free = empty.
 */

const MM = 72 / 25.4;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.38, 0.38, 0.42);
const RULE = rgb(0.8, 0.8, 0.83);
const BAND = rgb(0.95, 0.95, 0.96);

export interface ReportEventInfo {
  title: string;
  /** Pre-formatted date/time line, e.g. "Sat, 14 November 2026, 19:30". */
  dateLine: string;
  timeZone: string;
  generatedAt: Date;
  locale: string;
}

export interface OccupancyLabels {
  title: string;
  generated: string;
  pageOf: string;
  section: string;
  row: string;
  seat: string;
  holder: string;
  status: string;
  statuses: Record<OccupancyStatus, string>;
  standing: string;
  noOccupied: string;
  noSeats: string;
  totals: string;
}

class Sheet {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: PdfFonts,
    readonly size: [number, number],
    readonly margin: number,
    private readonly onPage: (sheet: Sheet) => void,
  ) {}

  get left() {
    return this.margin;
  }
  get right() {
    return this.size[0] - this.margin;
  }
  get width() {
    return this.size[0] - 2 * this.margin;
  }
  get bottom() {
    return this.margin + 14;
  }

  addPage() {
    this.page = this.doc.addPage(this.size);
    this.pages.push(this.page);
    this.y = this.size[1] - this.margin;
    this.onPage(this);
  }

  ensure(height: number) {
    if (this.y - height < this.bottom) this.addPage();
  }

  text(
    value: string,
    x: number,
    y: number,
    o: { size?: number; font?: PDFFont; color?: RGB; align?: 'left' | 'right' | 'center' } = {},
  ) {
    const font = o.font ?? this.fonts.regular;
    const size = o.size ?? 9;
    const text = toPdfText(value, font).replaceAll('\n', ' ');
    const w = font.widthOfTextAtSize(text, size);
    const px = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.page.drawText(text, { x: px, y, size, font, color: o.color ?? INK });
  }

  /** Single line cut with an ellipsis to fit `width`. */
  fit(value: string, width: number, size: number, font = this.fonts.regular): string {
    let text = toPdfText(value, font).replaceAll('\n', ' ');
    if (font.widthOfTextAtSize(text, size) <= width) return text;
    while (text.length > 1 && font.widthOfTextAtSize(`${text}…`, size) > width) {
      text = text.slice(0, -1);
    }
    return `${text}…`;
  }

  rule(y: number, color = RULE) {
    this.page.drawLine({
      start: { x: this.left, y },
      end: { x: this.right, y },
      thickness: 0.5,
      color,
    });
  }
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

async function create(
  event: ReportEventInfo,
  title: string,
  size: [number, number],
  margin: number,
  pageHeader: (sheet: Sheet) => void,
): Promise<Sheet> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await embedPdfFonts(doc);
  doc.setTitle(`${title} – ${event.title}`);
  doc.setProducer('tix-platform');
  doc.setCreator('tix-platform');
  doc.setLanguage(event.locale);
  doc.setCreationDate(event.generatedAt);
  doc.setModificationDate(event.generatedAt);
  const sheet = new Sheet(doc, fonts, size, margin, pageHeader);
  sheet.addPage();
  return sheet;
}

/** Page numbers + generation time in the footer of every page. */
function drawFooters(sheet: Sheet, event: ReportEventInfo, generated: string, pageOf: string) {
  const total = sheet.pages.length;
  const stamp = fill(generated, { time: formatReportTime(event.generatedAt, event.timeZone) });
  sheet.pages.forEach((page, i) => {
    sheet.page = page;
    sheet.text(`${event.title} · ${stamp}`, sheet.left, sheet.margin - 4, {
      size: 7,
      color: MUTED,
    });
    sheet.text(fill(pageOf, { page: i + 1, pages: total }), sheet.right, sheet.margin - 4, {
      size: 7,
      color: MUTED,
      align: 'right',
    });
  });
}

function titleBlock(sheet: Sheet, event: ReportEventInfo, title: string) {
  sheet.text(title, sheet.left, sheet.y - 14, { size: 16, font: sheet.fonts.bold });
  sheet.text(event.title, sheet.left, sheet.y - 30, { size: 11, font: sheet.fonts.bold });
  sheet.text(event.dateLine, sheet.left, sheet.y - 43, { size: 9, color: MUTED });
  sheet.y -= 54;
}

const CELL_W = 17;
const CELL_H = 14;
const CELL_GAP = 2;
const ROW_LABEL_W = 44;

function drawCell(
  sheet: Sheet,
  status: OccupancyStatus,
  label: string,
  x: number,
  y: number,
  w = CELL_W,
  h = CELL_H,
) {
  const page = sheet.page;
  const dark = status === 'SOLD';
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    borderColor: rgb(0.25, 0.25, 0.28),
    borderWidth: 0.6,
    color: dark ? rgb(0.2, 0.2, 0.23) : status === 'RESERVED' ? rgb(0.75, 0.75, 0.78) : undefined,
  });
  if (status === 'BLOCKED') {
    const line = { thickness: 0.6, color: rgb(0.25, 0.25, 0.28) };
    page.drawLine({ start: { x, y }, end: { x: x + w, y: y + h }, ...line });
    page.drawLine({ start: { x, y: y + h }, end: { x: x + w, y }, ...line });
  }
  if (label) {
    sheet.text(label, x + w / 2, y + h / 2 - 2.3, {
      size: 6.5,
      align: 'center',
      color: dark ? rgb(1, 1, 1) : INK,
      font: sheet.fonts.bold,
    });
  }
}

export async function buildOccupancyPdf(
  occupancy: Occupancy,
  event: ReportEventInfo,
  labels: OccupancyLabels,
  options: { includeHolders: boolean },
): Promise<Uint8Array> {
  const sheet = await create(event, labels.title, [210 * MM, 297 * MM], 15 * MM, () => {});
  titleBlock(sheet, event, labels.title);

  // Totals + legend
  const t = occupancy.totals;
  sheet.text(
    fill(labels.totals, { sold: t.SOLD, reserved: t.RESERVED, blocked: t.BLOCKED, free: t.FREE }),
    sheet.left,
    sheet.y - 8,
    { size: 9 },
  );
  sheet.y -= 20;
  let lx = sheet.left;
  for (const status of ['SOLD', 'RESERVED', 'BLOCKED', 'FREE'] as const) {
    drawCell(sheet, status, '', lx, sheet.y - CELL_H);
    sheet.text(labels.statuses[status], lx + CELL_W + 4, sheet.y - CELL_H + 4, { size: 8 });
    lx += CELL_W + 14 + sheet.fonts.regular.widthOfTextAtSize(labels.statuses[status], 8);
  }
  sheet.y -= CELL_H + 14;

  const perLine = Math.max(1, Math.floor((sheet.width - ROW_LABEL_W) / (CELL_W + CELL_GAP)));

  for (const section of occupancy.sections) {
    const seatCount = section.rows.reduce((n, r) => n + r.seats.length, 0);
    const counts: Record<OccupancyStatus, number> = { SOLD: 0, RESERVED: 0, BLOCKED: 0, FREE: 0 };
    for (const row of section.rows) for (const s of row.seats) counts[s.status] += 1;
    const firstRowHeight = options.includeHolders ? 40 : CELL_H + 22;
    sheet.ensure(24 + firstRowHeight);
    sheet.page.drawRectangle({
      x: sheet.left,
      y: sheet.y - 17,
      width: sheet.width,
      height: 17,
      color: BAND,
    });
    sheet.text(
      sheet.fit(section.name, sheet.width * 0.55, 10, sheet.fonts.bold),
      sheet.left + 5,
      sheet.y - 12,
      {
        size: 10,
        font: sheet.fonts.bold,
      },
    );
    const summary =
      section.type === 'STANDING'
        ? fill(labels.standing, {
            sold: section.standingSold,
            reserved: section.standingReserved,
            capacity: section.capacity ?? '–',
          })
        : fill(labels.totals, {
            sold: counts.SOLD,
            reserved: counts.RESERVED,
            blocked: counts.BLOCKED,
            free: counts.FREE,
          });
    sheet.text(sheet.fit(summary, sheet.width * 0.43, 8), sheet.right - 5, sheet.y - 12, {
      size: 8,
      color: MUTED,
      align: 'right',
    });
    sheet.y -= 24;

    if (section.type === 'STANDING') continue;
    if (seatCount === 0) {
      sheet.text(labels.noSeats, sheet.left + 5, sheet.y - 8, { size: 8, color: MUTED });
      sheet.y -= 16;
      continue;
    }

    if (options.includeHolders) {
      const colRow = 60;
      const colSeat = 45;
      const colStatus = 80;
      const header = () => {
        sheet.text(labels.row, sheet.left + 5, sheet.y - 8, { size: 8, font: sheet.fonts.bold });
        sheet.text(labels.seat, sheet.left + 5 + colRow, sheet.y - 8, {
          size: 8,
          font: sheet.fonts.bold,
        });
        sheet.text(labels.status, sheet.left + 5 + colRow + colSeat, sheet.y - 8, {
          size: 8,
          font: sheet.fonts.bold,
        });
        sheet.text(labels.holder, sheet.left + 5 + colRow + colSeat + colStatus, sheet.y - 8, {
          size: 8,
          font: sheet.fonts.bold,
        });
        sheet.rule(sheet.y - 12);
        sheet.y -= 16;
      };
      header();
      let any = false;
      for (const row of section.rows) {
        for (const s of row.seats) {
          if (s.status === 'FREE') continue;
          any = true;
          if (sheet.y - 12 < sheet.bottom) {
            sheet.addPage();
            header();
          }
          sheet.text(sheet.fit(row.label || '–', colRow - 6, 8), sheet.left + 5, sheet.y - 8, {
            size: 8,
          });
          sheet.text(sheet.fit(s.label, colSeat - 6, 8), sheet.left + 5 + colRow, sheet.y - 8, {
            size: 8,
          });
          sheet.text(labels.statuses[s.status], sheet.left + 5 + colRow + colSeat, sheet.y - 8, {
            size: 8,
          });
          sheet.text(
            sheet.fit(
              s.holder ?? '',
              sheet.right - (sheet.left + 5 + colRow + colSeat + colStatus),
              8,
            ),
            sheet.left + 5 + colRow + colSeat + colStatus,
            sheet.y - 8,
            { size: 8 },
          );
          sheet.y -= 12;
        }
      }
      if (!any) {
        sheet.text(labels.noOccupied, sheet.left + 5, sheet.y - 8, { size: 8, color: MUTED });
        sheet.y -= 12;
      }
      sheet.y -= 8;
      continue;
    }

    for (const row of section.rows) {
      for (let i = 0; i < row.seats.length || i === 0; i += perLine) {
        sheet.ensure(CELL_H + CELL_GAP + 2);
        const top = sheet.y - CELL_H;
        if (i === 0) {
          sheet.text(
            sheet.fit(row.label || '–', ROW_LABEL_W - 6, 8, sheet.fonts.bold),
            sheet.left + ROW_LABEL_W - 6,
            top + 4,
            {
              size: 8,
              font: sheet.fonts.bold,
              align: 'right',
            },
          );
        }
        row.seats.slice(i, i + perLine).forEach((s, k) => {
          drawCell(
            sheet,
            s.status,
            s.label,
            sheet.left + ROW_LABEL_W + k * (CELL_W + CELL_GAP),
            top,
          );
        });
        sheet.y -= CELL_H + CELL_GAP + 2;
      }
    }
    sheet.y -= 8;
  }

  drawFooters(sheet, event, labels.generated, labels.pageOf);
  return sheet.doc.save();
}

export async function buildGuestListPdf(
  rows: GuestListRow[],
  event: ReportEventInfo,
  labels: GuestListLabels,
): Promise<Uint8Array> {
  const ROW_H = 14;
  const fractions = [0.2, 0.09, 0.13, 0.12, 0.12, 0.05, 0.05, 0.09, 0.15];
  const columns = [
    labels.name,
    labels.orderNumber,
    labels.category,
    labels.tariff,
    labels.block,
    labels.row,
    labels.seat,
    labels.ticketStatus,
    labels.checkIn,
  ];
  const sheet = await create(event, labels.title, [297 * MM, 210 * MM], 12 * MM, () => {});
  titleBlock(sheet, event, labels.title);
  sheet.text(fill(labels.count, { count: rows.length }), sheet.right, sheet.y + 45, {
    size: 9,
    color: MUTED,
    align: 'right',
  });
  const xs: number[] = [];
  const widths = fractions.map((f) => f * sheet.width);
  widths.reduce((x, w) => {
    xs.push(x);
    return x + w;
  }, sheet.left);

  const header = () => {
    sheet.page.drawRectangle({
      x: sheet.left,
      y: sheet.y - ROW_H,
      width: sheet.width,
      height: ROW_H,
      color: BAND,
    });
    columns.forEach((c, i) =>
      sheet.text(
        sheet.fit(c, widths[i]! - 6, 8, sheet.fonts.bold),
        xs[i]! + 3,
        sheet.y - ROW_H + 4,
        {
          size: 8,
          font: sheet.fonts.bold,
        },
      ),
    );
    sheet.y -= ROW_H;
  };
  header();

  rows.forEach((r, index) => {
    if (sheet.y - ROW_H < sheet.bottom) {
      sheet.addPage();
      header();
    }
    const voided = r.ticketStatus !== 'VALID';
    const checkIn =
      r.checkInState === 'NONE'
        ? ''
        : `${labels.checkInStates[r.checkInState]}${r.checkedInAt ? ` ${formatReportTime(r.checkedInAt, event.timeZone)}` : ''}`;
    const cells = [
      r.name,
      r.orderNumber,
      r.categoryName,
      r.ticketTypeName,
      r.sectionLabel,
      r.rowLabel ?? '',
      r.seatLabel ?? '',
      labels.ticketStatuses[r.ticketStatus],
      checkIn,
    ];
    if (index % 2 === 1) {
      sheet.page.drawRectangle({
        x: sheet.left,
        y: sheet.y - ROW_H,
        width: sheet.width,
        height: ROW_H,
        color: rgb(0.975, 0.975, 0.98),
      });
    }
    cells.forEach((c, i) =>
      sheet.text(sheet.fit(c, widths[i]! - 6, 8), xs[i]! + 3, sheet.y - ROW_H + 4, {
        size: 8,
        color: voided ? MUTED : INK,
      }),
    );
    sheet.y -= ROW_H;
  });
  if (rows.length === 0) sheet.rule(sheet.y);

  drawFooters(sheet, event, labels.generated, labels.pageOf);
  return sheet.doc.save();
}
