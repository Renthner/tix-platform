import { ticketLayoutSchema, type TicketLayout } from '../schemas/ticket-template';

/**
 * Built-in ticket design: the event cover (16:9 recommended) as a full-width header band,
 * the data block on the left and the QR code on the right. The page is as wide as
 * `DEFAULT_TICKET_WIDTH_MM`, the band is exactly 16:9 and the page height follows from the
 * band plus the data area, so a recommended cover is not cropped.
 * Labels use `{{label.*}}` placeholders which the renderer localizes. Used as seed for the
 * global default template, as the renderer's last-resort fallback and as the designer's
 * "reset".
 */
export const DEFAULT_TICKET_WIDTH_MM = 150;
/** Height of the area below the cover band (data block + QR code + margins). */
const DATA_AREA_MM = 66;

export interface DefaultTicketDesign {
  pageWidthMm: number;
  pageHeightMm: number;
  layout: TicketLayout;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Default design for a cover of the given aspect ratio (width / height; default 16:9). */
export function defaultTicketDesign(coverAspect = 16 / 9): DefaultTicketDesign {
  const width = DEFAULT_TICKET_WIDTH_MM;
  const band = round(width / coverAspect);
  const top = round(band + 4);
  const colWidth = width - 60;
  const qrSize = 34;
  const qrX = width - 10 - qrSize;

  const text = (
    id: string,
    field: string,
    x: number,
    y: number,
    w: number,
    size: number,
    extra: Record<string, unknown> = {},
  ) => ({
    kind: 'text' as const,
    id,
    field,
    x,
    y: round(y),
    width: w,
    height: round(size * 0.5),
    rotation: 0,
    fontFamily: 'Noto Sans',
    fontSize: size,
    fontWeight: 'normal' as const,
    color: '#111111',
    align: 'left' as const,
    uppercase: false,
    ...extra,
  });
  const label = (id: string, key: string, x: number, y: number, w: number) =>
    text(id, 'STATIC_TEXT', x, y, w, 6.5, {
      text: `{{label.${key}}}`,
      color: '#777777',
      uppercase: true,
      height: 3.5,
    });

  const half = round((colWidth - 4) / 2);
  const rightX = round(10 + half + 4);
  const layout = ticketLayoutSchema.parse({
    version: 1,
    qr: { x: qrX, y: round(top + 2), size: qrSize, errorCorrection: 'M', margin: 1 },
    elements: [
      { kind: 'cover', id: 'cover', x: 0, y: 0, width, height: band, fit: 'cover' },
      text('title', 'EVENT_TITLE', 10, top, colWidth, 18, { fontWeight: 'bold', height: 9 }),
      text('subtitle', 'EVENT_SUBTITLE', 10, top + 10, colWidth, 9, {
        color: '#555555',
        height: 5,
      }),
      label('l-date', 'date', 10, top + 19, half),
      text('date', 'EVENT_DATE', 10, top + 22.5, half, 11, {
        fontWeight: 'bold',
        dateStyle: 'long',
        height: 5.5,
      }),
      label('l-time', 'time', rightX, top + 19, half),
      text('time', 'EVENT_TIME', rightX, top + 22.5, half, 11, { fontWeight: 'bold', height: 5.5 }),
      label('l-doors', 'doors', 10, top + 31, half),
      text('doors', 'DOORS_TIME', 10, top + 34.5, half, 11, { height: 5.5 }),
      label('l-venue', 'venue', rightX, top + 31, half),
      text('venue', 'VENUE_NAME', rightX, top + 34.5, half, 11, { height: 5.5 }),
      label('l-seat', 'seat', 10, top + 42, colWidth),
      text('seat', 'SEAT_FULL', 10, top + 45.5, colWidth, 12, { fontWeight: 'bold', height: 6 }),
      text('category', 'STATIC_TEXT', 10, top + 53, colWidth, 8, {
        text: '{{priceCategory}} · {{ticketType}}',
        color: '#555555',
        height: 4.5,
      }),
      {
        kind: 'shape',
        id: 'divider',
        shape: 'rect',
        x: qrX - 5,
        y: round(top + 2),
        width: 0.3,
        height: 54,
        fill: '#DDDDDD',
      },
      text('code', 'TICKET_CODE', qrX - 4, top + 38, qrSize + 8, 9, {
        fontFamily: 'Noto Sans',
        fontWeight: 'bold',
        align: 'center',
        height: 4.5,
      }),
      text('attendee', 'ATTENDEE_NAME', qrX - 4, top + 44, qrSize + 8, 8, {
        align: 'center',
        height: 4.5,
      }),
      text('order', 'STATIC_TEXT', qrX - 4, top + 50, qrSize + 8, 6.5, {
        text: '{{label.order}} {{orderNumber}}',
        color: '#777777',
        align: 'center',
        height: 3.5,
      }),
    ],
  });
  return { pageWidthMm: width, pageHeightMm: round(band + DATA_AREA_MM), layout };
}

const DEFAULT_DESIGN = defaultTicketDesign();
export const DEFAULT_TICKET_PAGE_MM = {
  width: DEFAULT_DESIGN.pageWidthMm,
  height: DEFAULT_DESIGN.pageHeightMm,
} as const;

/** Layout of the built-in design (16:9 cover). */
export function defaultTicketLayout(): TicketLayout {
  return defaultTicketDesign().layout;
}
