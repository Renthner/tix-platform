import 'server-only';
import { buildIcs, calendarFileName, calendarUidHost, type CalendarEventDetail } from '@tix/core';
import { getCore } from './core';

/** `.ics` download of one or more events (UTC times, see core `buildIcs`). */
export function calendarResponse(
  events: CalendarEventDetail[],
  options: { cache: 'public' | 'private' },
): Response {
  const core = getCore();
  const body = buildIcs(events, { uidHost: calendarUidHost(core) });
  const name = events.length === 1 ? calendarFileName(events[0]!.title) : 'events';
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${name}.ics"`,
      'cache-control': options.cache === 'public' ? 'public, max-age=300' : 'private, no-store',
    },
  });
}
