import { DomainError, loadCalendarEvents } from '@tix/core';
import { calendarResponse } from '@/server/calendar-response';
import { handle, localeParam } from '@/server/http';
import { loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

/** Calendar file (.ics) of a shop event; drafts are only visible to signed-in super admins (404 otherwise). */
export async function GET(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event, actor } = await loadShopEvent((await params).eventId);
    const [detail] = await loadCalendarEvents(core, [event.id], localeParam(request));
    if (!detail) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
    return calendarResponse([detail], { cache: actor ? 'private' : 'public' });
  });
}
