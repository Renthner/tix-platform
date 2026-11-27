import { listCustomers, searchOrders } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hasRole, adminForApi } from '@/server/auth';
import { listEventsPage } from '@/server/admin/queries';
import { getCore } from '@/server/core';
import { apiError, enforceRateLimit, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Hits per entity type: the palette is for jumping, the list pages are for browsing. */
const LIMIT = 5;

const querySchema = z.object({ q: z.string().trim().min(2).max(100) });

export interface AdminSearchResponse {
  orders: {
    id: string;
    orderNumber: string;
    name: string;
    email: string | null;
    paymentReference: string | null;
  }[];
  customers: { id: string; name: string; email: string }[];
  events: { id: string; title: string; startsAt: string; venueName: string | null }[];
}

/**
 * GET `?q=` – live results of the admin search palette: orders (number, payment reference,
 * buyer e-mail / name), customers (e-mail / name) and events (title). Every entity type follows
 * the same role rule as its list page; types the user may not see stay empty.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi();
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    await enforceRateLimit('admin-search', session.userId, 120, 60_000);
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return apiError('INVALID_QUERY', 'Invalid query', 400);
    const q = query.data.q;
    const core = getCore();
    const salesRoles = hasRole(session, ['FINANCE', 'EVENT_MANAGER']);
    const [orderRows, customerRows, eventRows] = await Promise.all([
      salesRoles
        ? searchOrders(core, { q, page: 1, pageSize: LIMIT, tests: 'hide' }).then((r) => r.rows)
        : [],
      salesRoles ? listCustomers(core, { q, page: 1, pageSize: LIMIT }).then((r) => r.rows) : [],
      hasRole(session, ['EVENT_MANAGER'])
        ? listEventsPage({ q, page: 1, pageSize: LIMIT }).then((r) => r.rows)
        : [],
    ]);
    const body: AdminSearchResponse = {
      orders: orderRows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        name: [o.firstName, o.lastName].filter(Boolean).join(' '),
        email: o.email,
        paymentReference: o.paymentReference,
      })),
      customers: customerRows.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' '),
        email: c.email,
      })),
      events: eventRows.map(({ event, venueName }) => ({
        id: event.id,
        title: event.title,
        startsAt: event.startsAt.toISOString(),
        venueName,
      })),
    };
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
  });
}
