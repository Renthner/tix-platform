import { venueMapsUrl } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import {
  buildIcs,
  calendarFileName,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  googleCalendarUrl,
  type CalendarEvent,
} from '../src/calendar/ics';

const base: CalendarEvent = {
  id: '5d2f0c64-0000-4000-8000-000000000001',
  title: 'Summer Gala, Part 1; "live"',
  description: 'Doors open 18:30\nLine two with a \\ backslash',
  startsAt: new Date('2026-07-04T18:00:00Z'),
  endsAt: new Date('2026-07-04T21:00:00Z'),
  location: 'City Hall, Main St 1, 12345 Town',
  latitude: 50.1,
  longitude: 8.5,
  url: 'https://shop.example.org/en/events/gala',
  organizerName: 'Club "Sample" e.V.',
  organizerEmail: 'tickets@example.org',
};

const octets = (s: string) => new TextEncoder().encode(s).length;

describe('ics generation', () => {
  it('formats UTC times without separators', () => {
    expect(formatIcsUtc(new Date('2026-03-29T01:30:00.123Z'))).toBe('20260329T013000Z');
  });

  it('escapes backslash, semicolon, comma and line breaks', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('folds at 75 octets without splitting UTF-8 sequences', () => {
    const line = `SUMMARY:${'Müller äöü €uro 😀 '.repeat(12)}`;
    const folded = foldIcsLine(line).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const [i, part] of folded.entries()) {
      expect(octets(part)).toBeLessThanOrEqual(75);
      if (i > 0) expect(part.startsWith(' ')).toBe(true);
    }
    // Unfolding restores the original line exactly.
    expect(folded.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
    expect(foldIcsLine('SHORT:line')).toBe('SHORT:line');
  });

  it('builds a CRLF document with UTC times, stable UID and organizer', () => {
    const ics = buildIcs([base], {
      uidHost: 'shop.example.org',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('UID:5d2f0c64-0000-4000-8000-000000000001@shop.example.org');
    expect(lines).toContain('DTSTAMP:20260101T000000Z');
    expect(lines).toContain('DTSTART:20260704T180000Z');
    expect(lines).toContain('DTEND:20260704T210000Z');
    expect(lines).toContain('SUMMARY:Summer Gala\\, Part 1\\; "live"');
    expect(lines).toContain('GEO:50.1;8.5');
    expect(ics).toContain('ORGANIZER;CN="Club Sample e.V.":mailto:tickets@example.org');
    // Unfolded content keeps the escaped description.
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('DESCRIPTION:Doors open 18:30\\nLine two with a \\\\ backslash');
  });

  it('omits ORGANIZER without a mailto address', () => {
    const ics = buildIcs([{ ...base, organizerEmail: null }], { uidHost: 'x' });
    expect(ics).not.toContain('ORGANIZER');
    const bad = buildIcs([{ ...base, organizerEmail: 'not an address' }], { uidHost: 'x' });
    expect(bad).not.toContain('ORGANIZER');
  });

  it('builds a Google Calendar link with dates, location and details', () => {
    const url = new URL(googleCalendarUrl(base));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('dates')).toBe('20260704T180000Z/20260704T210000Z');
    expect(url.searchParams.get('text')).toBe(base.title);
    expect(url.searchParams.get('location')).toBe(base.location);
    expect(url.searchParams.get('details')).toContain(base.url!);
  });

  it('derives an ASCII file name', () => {
    expect(calendarFileName('Münchner Märchen – Wiedersehen!')).toBe(
      'Munchner-Marchen-Wiedersehen',
    );
    expect(calendarFileName('!!!')).toBe('event');
  });
});

describe('venue maps url', () => {
  it('prefers the venue link, then coordinates, then the address', () => {
    expect(venueMapsUrl({ name: 'Hall', mapsUrl: 'https://maps.app.goo.gl/abc' })).toBe(
      'https://maps.app.goo.gl/abc',
    );
    expect(
      venueMapsUrl({ name: 'Hall', mapsUrl: 'javascript:alert(1)', latitude: 1, longitude: 2 }),
    ).toBe('https://www.google.com/maps/search/?api=1&query=1%2C2');
    expect(
      venueMapsUrl({ name: 'Hall', street: 'Main St 1', postalCode: '12345', city: 'Town' }),
    ).toBe(
      'https://www.google.com/maps/search/?api=1&query=Hall%2C%20Main%20St%201%2C%2012345%2C%20Town',
    );
  });
});
