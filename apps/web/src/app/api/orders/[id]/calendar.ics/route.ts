import { DomainError, loadOrderCalendarEvents } from '@tix/core';
import { calendarResponse } from '@/server/calendar-response';
import { getCore } from '@/server/core';
import { handle, uuidParam } from '@/server/http';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

/**
 * GET – calendar file (.ics) of the events of an order (guest link token or customer account);
 * `?event=<id>` limits it to one event.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const orderId = uuidParam.parse((await params).id);
    const url = new URL(request.url);
    if (!(await canAccessOrder(orderId, url.searchParams.get('t')))) {
      throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    const eventParam = url.searchParams.get('event');
    const events = await loadOrderCalendarEvents(getCore(), orderId, {
      ...(eventParam ? { eventId: uuidParam.parse(eventParam) } : {}),
    });
    if (events.length === 0) throw new DomainError('EVENT_NOT_FOUND', 'No events', 404);
    return calendarResponse(events, { cache: 'private' });
  });
}
