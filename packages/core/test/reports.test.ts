import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  buildGuestListCsv,
  buildGuestListPdf,
  buildOccupancyPdf,
  formatReportTime,
  sortGuestList,
  type GuestListLabels,
  type GuestListRow,
  type Occupancy,
  type OccupancyLabels,
  type OccupancySeat,
  type ReportEventInfo,
} from '../src';

const labels: GuestListLabels = {
  title: 'Guest list',
  name: 'Name',
  orderNumber: 'Order no.',
  category: 'Category',
  tariff: 'Tariff',
  block: 'Block',
  row: 'Row',
  seat: 'Seat',
  ticketStatus: 'Ticket status',
  checkIn: 'Check-in',
  checkInTime: 'Check-in time',
  ticketStatuses: {
    VALID: 'Valid',
    CANCELLED: 'Cancelled',
    REFUNDED: 'Refunded',
    REPLACED: 'Replaced',
  },
  checkInStates: { NONE: 'Not arrived', CHECKED_IN: 'Inside', CHECKED_OUT: 'Checked out' },
  generated: 'Created {time}',
  pageOf: 'Page {page} of {pages}',
  count: '{count} tickets',
};

const occLabels: OccupancyLabels = {
  title: 'Seating occupancy',
  generated: 'Created {time}',
  pageOf: 'Page {page} of {pages}',
  section: 'Block',
  row: 'Row',
  seat: 'Seat',
  holder: 'Name',
  status: 'Status',
  statuses: { SOLD: 'Sold', RESERVED: 'Reserved', BLOCKED: 'Blocked', FREE: 'Free' },
  standing: '{sold} sold of {capacity}',
  noOccupied: 'None.',
  noSeats: 'No seats.',
  totals: '{sold} sold, {reserved} reserved, {blocked} blocked, {free} free',
};

const event: ReportEventInfo = {
  title: 'Gala Évening',
  dateLine: 'Saturday, 14 November 2026, 19:30',
  timeZone: 'Europe/Berlin',
  generatedAt: new Date('2026-11-14T10:00:00Z'),
  locale: 'en',
};

const guest = (over: Partial<GuestListRow>): GuestListRow => ({
  ticketId: 't',
  name: 'Anna Beispiel',
  orderNumber: 'TIX-2026-000001',
  categoryName: 'Cat 1',
  ticketTypeName: 'Normal',
  sectionLabel: 'Stalls',
  rowLabel: 'A',
  seatLabel: '1',
  ticketStatus: 'VALID',
  checkInState: 'NONE',
  checkedInAt: null,
  ...over,
});

describe('guest list CSV', () => {
  it('has BOM, ; separator, CRLF and neutralises formula injection', () => {
    const csv = buildGuestListCsv(
      [
        guest({ name: '=HYPERLINK("http://x")', orderNumber: 'A;B' }),
        guest({ name: '+1', rowLabel: null, seatLabel: null }),
        guest({ name: '-2' }),
        guest({ name: '@SUM(1)' }),
        guest({
          name: 'Zoë "Z" Müller',
          checkInState: 'CHECKED_IN',
          checkedInAt: new Date('2026-11-14T18:05:00Z'),
        }),
      ],
      labels,
      'Europe/Berlin',
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      '﻿Name;Order no.;Category;Tariff;Block;Row;Seat;Ticket status;Check-in;Check-in time',
    );
    expect(lines[1]).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(lines[1]).toContain('"A;B"');
    expect(lines[2]!.startsWith("'+1;")).toBe(true);
    expect(lines[3]!.startsWith("'-2;")).toBe(true);
    expect(lines[4]!.startsWith("'@SUM(1);")).toBe(true);
    expect(lines[5]).toContain('"Zoë ""Z"" Müller"');
    expect(lines[5]).toContain(';Inside;2026-11-14 19:05');
  });

  it('formats times in the given zone', () => {
    expect(formatReportTime(new Date('2026-07-01T22:30:00Z'), 'Europe/Berlin')).toBe(
      '2026-07-02 00:30',
    );
  });
});

describe('guest list sorting', () => {
  const rows = [
    guest({ name: 'Zed', rowLabel: 'B', seatLabel: '10' }),
    guest({ name: 'Åsa', rowLabel: 'B', seatLabel: '2' }),
    guest({ name: 'Bob', rowLabel: 'A', seatLabel: '5' }),
  ];
  it('by seat uses natural order', () => {
    expect(sortGuestList(rows, 'seat').map((r) => r.name)).toEqual(['Bob', 'Åsa', 'Zed']);
  });
  it('by name is alphabetical', () => {
    expect(sortGuestList(rows, 'name', 'en').map((r) => r.name)).toEqual(['Åsa', 'Bob', 'Zed']);
  });
});

async function parse(bytes: Uint8Array) {
  expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  return PDFDocument.load(bytes);
}

describe('guest list PDF', () => {
  it('renders many rows over several landscape A4 pages incl. non-Latin names', async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      guest({
        name: i === 0 ? 'Иван Петров' : `Guest ${i}`,
        seatLabel: String(i),
        ticketStatus: i % 10 === 0 ? 'CANCELLED' : 'VALID',
        checkInState: i % 3 === 0 ? 'CHECKED_IN' : 'NONE',
        checkedInAt: i % 3 === 0 ? new Date('2026-11-14T18:00:00Z') : null,
      }),
    );
    const doc = await parse(await buildGuestListPdf(rows, event, labels));
    expect(doc.getPageCount()).toBeGreaterThan(2);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(842);
    expect(Math.round(height)).toBe(595);
  });

  it('renders an empty list', async () => {
    const doc = await parse(await buildGuestListPdf([], event, labels));
    expect(doc.getPageCount()).toBe(1);
  });
});

describe('occupancy PDF', () => {
  const seat = (label: string, status: OccupancySeat['status']): OccupancySeat => ({
    label,
    status,
    holder: status === 'SOLD' || status === 'RESERVED' ? `Holder ${label}` : null,
  });
  const statuses = ['SOLD', 'FREE', 'BLOCKED', 'RESERVED'] as const;
  const occupancy: Occupancy = {
    totals: { SOLD: 10, RESERVED: 5, BLOCKED: 5, FREE: 30 },
    sections: [
      {
        name: 'Stalls',
        type: 'SEATED',
        capacity: null,
        standingSold: 0,
        standingReserved: 0,
        rows: Array.from({ length: 30 }, (_, r) => ({
          label: String(r + 1),
          seats: Array.from({ length: 40 }, (_, s) => seat(String(s + 1), statuses[(r + s) % 4]!)),
        })),
      },
      {
        name: 'Floor',
        type: 'STANDING',
        capacity: 100,
        standingSold: 3,
        standingReserved: 1,
        rows: [],
      },
    ],
  };

  it('draws the seat grid over several A4 pages', async () => {
    const doc = await parse(
      await buildOccupancyPdf(occupancy, event, occLabels, { includeHolders: false }),
    );
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(Math.round(doc.getPage(0).getSize().width)).toBe(595);
  });

  it('lists holders when requested', async () => {
    const doc = await parse(
      await buildOccupancyPdf(occupancy, event, occLabels, { includeHolders: true }),
    );
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});
