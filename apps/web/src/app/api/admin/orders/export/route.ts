import {
  buildCsv,
  formatCsvAmount,
  getSetting,
  searchOrdersForExport,
  type CsvCell,
  type OrderExportCursor,
} from '@tix/core';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { routing } from '@/i18n/routing';
import { audit } from '@/server/admin/audit';
import {
  ORDERS_TESTS_COOKIE,
  parseOrderFilters,
  toOrderSearch,
} from '@/server/admin/order-filters';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

const EXPORT_PAGE = 200;
/** Hard cap so one request cannot read the whole table. */
const EXPORT_MAX_ROWS = 20_000;

/**
 * GET – CSV of the order list with the list's filters (same roles as the list). UTF-8 BOM, `;`,
 * decimal comma, formula-safe cells (`buildCsv`). Audited with the filters and the row count.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['FINANCE', 'EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
    const locale = hasLocale(routing.locales, sp.locale) ? sp.locale : routing.defaultLocale;
    const core = getCore();
    const cookieStore = await cookies();
    const filters = parseOrderFilters(sp, {
      isSuperAdmin: session.roles.includes('SUPER_ADMIN'),
      cookieTests: cookieStore.get(ORDERS_TESTS_COOKIE)?.value,
    });
    const general = await getSetting(core, 'general');
    const search = toOrderSearch(filters, general.defaultTimeZone);
    const [t, tStatus, tMethod, tChannel] = await Promise.all([
      getTranslations({ locale, namespace: 'orders.admin.csv' }),
      getTranslations({ locale, namespace: 'orders.status' }),
      getTranslations({ locale, namespace: 'orders.method' }),
      getTranslations({ locale, namespace: 'orders.channel' }),
    ]);
    const dateFmt = new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: general.defaultTimeZone,
    });

    // Keyset paging (newest first): orders created while the export runs cannot shift the pages.
    const rows: CsvCell[][] = [];
    let after: OrderExportCursor | null = null;
    let truncated = false;
    while (rows.length < EXPORT_MAX_ROWS) {
      const result = await searchOrdersForExport(core, search, {
        after,
        limit: Math.min(EXPORT_PAGE, EXPORT_MAX_ROWS - rows.length),
      });
      for (const r of result.rows) {
        rows.push([
          r.orderNumber,
          dateFmt.format(r.createdAt),
          `${r.firstName} ${r.lastName}`.trim(),
          r.email,
          tMethod(r.paymentMethod),
          tChannel(r.channel),
          tStatus(r.status),
          r.ticketCount,
          formatCsvAmount(r.totalGross),
          formatCsvAmount(r.amountPaid),
          r.currency,
          r.paymentReference,
          r.isTest ? t('yes') : '',
        ]);
      }
      if (!result.next) break;
      after = result.next;
      truncated = rows.length >= EXPORT_MAX_ROWS;
    }
    const exported = rows.length;
    // Cut off at the cap: a last row says so (visible in the file the admin opens).
    if (truncated) rows.push([t('truncated', { max: EXPORT_MAX_ROWS })]);
    const body = buildCsv(
      [
        t('number'),
        t('date'),
        t('customer'),
        t('email'),
        t('method'),
        t('channel'),
        t('status'),
        t('tickets'),
        t('total'),
        t('paid'),
        t('currency'),
        t('reference'),
        t('test'),
      ],
      rows,
    );
    await audit(core.db, session, 'orders.export', 'orders', null, {
      filters,
      rows: exported,
      truncated,
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`,
        'x-export-rows': String(exported),
        'x-export-truncated': truncated ? '1' : '0',
        'cache-control': 'no-store',
      },
    });
  });
}
