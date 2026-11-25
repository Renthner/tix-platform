import 'server-only';
import {
  ORDER_SORT_KEYS,
  localDateOf,
  formatLocalDate,
  parseLocalDate,
  type OrderSearch,
  type OrderSortKey,
} from '@tix/core';
import {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  SALES_CHANNELS,
  type OrderStatus,
  type PaymentMethod,
  type SalesChannel,
} from '@tix/shared';

/** Cookie remembering a super admin's test-order filter choice. */
export const ORDERS_TESTS_COOKIE = 'tix_orders_tests';

export type TestsChoice = 'hide' | 'all' | 'only';
const TESTS_CHOICES: readonly string[] = ['hide', 'all', 'only'];

export interface OrderFilterParams {
  q?: string;
  status?: OrderStatus;
  method?: PaymentMethod;
  channel?: SalesChannel;
  event?: string;
  overdue?: '1';
  open?: '1';
  today?: '1';
  from?: string;
  to?: string;
  tests: TestsChoice;
  sort?: OrderSortKey;
  dir?: 'asc' | 'desc';
}

const pick = <T extends string>(all: readonly string[], v: string | undefined) =>
  v && all.includes(v) ? (v as T) : undefined;

/**
 * Parses the order list filters (page and CSV export share this). Test orders are hidden unless
 * the URL says otherwise; a super admin's last explicit choice (cookie) is the fallback.
 */
export function parseOrderFilters(
  sp: Record<string, string | undefined>,
  opts: { isSuperAdmin: boolean; cookieTests?: string },
): OrderFilterParams {
  const urlTests = pick<TestsChoice>(TESTS_CHOICES, sp.tests);
  const cookieTests = opts.isSuperAdmin
    ? pick<TestsChoice>(TESTS_CHOICES, opts.cookieTests)
    : undefined;
  const date = (v: string | undefined) => (v && parseLocalDate(v) ? v : undefined);
  const sort = pick<OrderSortKey>(ORDER_SORT_KEYS, sp.sort);
  return {
    q: sp.q?.trim().slice(0, 100) || undefined,
    status: pick<OrderStatus>(ORDER_STATUSES, sp.status),
    method: pick<PaymentMethod>(PAYMENT_METHODS, sp.method),
    channel: pick<SalesChannel>(SALES_CHANNELS, sp.channel),
    event: /^[0-9a-f-]{36}$/i.test(sp.event ?? '') ? sp.event : undefined,
    overdue: sp.overdue === '1' ? '1' : undefined,
    open: sp.open === '1' ? '1' : undefined,
    today: sp.today === '1' ? '1' : undefined,
    from: date(sp.from),
    to: date(sp.to),
    tests: urlTests ?? cookieTests ?? 'hide',
    sort,
    dir: sort ? (sp.dir === 'asc' ? 'asc' : 'desc') : undefined,
  };
}

/** Translates the parsed filters into the core search (the "today" chip = today's local date). */
export function toOrderSearch(
  f: OrderFilterParams,
  timeZone: string,
  now = new Date(),
): OrderSearch {
  const today = f.today ? formatLocalDate(localDateOf(now, timeZone)) : undefined;
  return {
    q: f.q,
    status: f.status,
    method: f.method,
    channel: f.channel,
    eventId: f.event,
    overdueOnly: f.overdue === '1',
    openOnly: f.open === '1',
    tests: f.tests === 'all' ? undefined : f.tests,
    from: today ?? f.from,
    to: today ?? f.to,
    timeZone,
    sort: f.sort,
    dir: f.dir,
  };
}
