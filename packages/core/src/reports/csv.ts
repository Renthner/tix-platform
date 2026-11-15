import type { CheckInState, TicketStatus } from '@tix/shared';
import { buildCsv } from '../accounting/csv';
import type { GuestListRow } from './data';

/** Translated texts of the guest list (CSV headers, PDF columns, status words). */
export interface GuestListLabels {
  title: string;
  name: string;
  orderNumber: string;
  category: string;
  tariff: string;
  block: string;
  row: string;
  seat: string;
  ticketStatus: string;
  checkIn: string;
  checkInTime: string;
  ticketStatuses: Record<TicketStatus, string>;
  checkInStates: Record<CheckInState, string>;
  /** "Generated {time}" / "Page {page} of {pages}" with the placeholders replaced by the renderer. */
  generated: string;
  pageOf: string;
  count: string;
}

/** Local time `YYYY-MM-DD HH:mm` (sortable in spreadsheets). */
export function formatReportTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Guest list CSV: UTF-8 BOM, `;`, CRLF, formula-injection safe (see accounting/csv). */
export function buildGuestListCsv(
  rows: GuestListRow[],
  labels: GuestListLabels,
  timeZone: string,
): string {
  return buildCsv(
    [
      labels.name,
      labels.orderNumber,
      labels.category,
      labels.tariff,
      labels.block,
      labels.row,
      labels.seat,
      labels.ticketStatus,
      labels.checkIn,
      labels.checkInTime,
    ],
    rows.map((r) => [
      r.name,
      r.orderNumber,
      r.categoryName,
      r.ticketTypeName,
      r.sectionLabel,
      r.rowLabel,
      r.seatLabel,
      labels.ticketStatuses[r.ticketStatus],
      labels.checkInStates[r.checkInState],
      r.checkedInAt ? formatReportTime(r.checkedInAt, timeZone) : null,
    ]),
  );
}
