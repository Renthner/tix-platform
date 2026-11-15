/**
 * iCalendar (RFC 5545) generation for "Add to calendar". Pure functions, no I/O.
 *
 * Times are written in UTC (`…Z`), which every calendar app converts to the viewer's zone – no
 * VTIMEZONE block is needed and daylight-saving changes cannot go wrong.
 */

export interface CalendarEvent {
  /** Stable id of the event; part of the UID so re-imports update instead of duplicating. */
  id: string;
  title: string;
  /** Plain-text description (doors, subtitle, link …). */
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  /** One-line location: "Venue, Street, 12345 City". */
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Public event page. */
  url: string | null;
  organizerName: string | null;
  organizerEmail: string | null;
}

/** `20260704T183000Z`. */
export function formatIcsUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** TEXT value escaping: backslash, semicolon, comma, line breaks. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\r\n?|\n/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Quoted parameter value (CN=…): quotes are not allowed inside, control characters dropped. */
function paramValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return `"${value.replace(/["\u0000-\u001f]/g, '')}"`;
}

/**
 * Folds a content line at 75 OCTETS (not characters); continuation lines start with one space.
 * Never splits a multi-byte UTF-8 sequence.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  // The first line may use 75 octets, continuation lines 74 (they start with a space).
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
      limit = 74;
    }
    current += char;
    size += bytes;
  }
  if (current) parts.push(current);
  return parts.join('\r\n ');
}

export interface IcsOptions {
  /** Domain part of the UID (`<eventId>@<uidHost>`), e.g. the shop's host name. */
  uidHost: string;
  /** Moment of generation (DTSTAMP). */
  now?: Date;
  /** Calendar name shown by some clients. */
  calendarName?: string;
}

/** The complete `.ics` document (CRLF line endings, folded lines). */
export function buildIcs(events: CalendarEvent[], options: IcsOptions): string {
  const stamp = formatIcsUtc(options.now ?? new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//tix-platform//Event calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  if (options.calendarName) lines.push(`X-WR-CALNAME:${escapeIcsText(options.calendarName)}`);
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.id}@${options.uidHost}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatIcsUtc(event.startsAt)}`,
      `DTEND:${formatIcsUtc(event.endsAt)}`,
      `SUMMARY:${escapeIcsText(event.title)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    if (event.latitude !== null && event.longitude !== null) {
      lines.push(`GEO:${event.latitude};${event.longitude}`);
    }
    if (event.url) lines.push(`URL:${event.url.replace(/[\r\n]/g, '')}`);
    // ORGANIZER needs a mailto: address; without one the organiser is part of the description.
    if (event.organizerEmail && /^[^\s@<>"]+@[^\s@<>"]+$/.test(event.organizerEmail)) {
      lines.push(
        `ORGANIZER${event.organizerName ? `;CN=${paramValue(event.organizerName)}` : ''}:mailto:${event.organizerEmail}`,
      );
    }
    lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/** "Add to Google Calendar" link (event template in the user's own calendar). */
export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${formatIcsUtc(event.startsAt)}/${formatIcsUtc(event.endsAt)}`,
  });
  const details = [event.description, event.url].filter(Boolean).join('\n\n');
  if (details) params.set('details', details);
  if (event.location) params.set('location', event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** File name for a download: ASCII slug of the title (the `.ics` suffix is added by the caller). */
export function calendarFileName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'event';
}
