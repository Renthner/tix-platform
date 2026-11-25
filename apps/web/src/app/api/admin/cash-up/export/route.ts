import { buildCsv, formatCsvAmount, getCashUpReport, getSetting } from '@tix/core';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { audit } from '@/server/admin/audit';
import { parseCashUpFilter } from '@/server/admin/cash-up-filters';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * GET – cash-up report as CSV (UTF-8 BOM, `;`, decimal comma). Same roles and scoping as the page:
 * door staff only get their own sales. Audited.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['FINANCE', 'EVENT_MANAGER', 'DOOR_STAFF']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
    const locale = hasLocale(routing.locales, sp.locale) ? sp.locale : routing.defaultLocale;
    const core = getCore();
    const general = await getSetting(core, 'general');
    const filter = parseCashUpFilter(sp, session, general.defaultTimeZone);
    const [report, t, tMethod] = await Promise.all([
      getCashUpReport(core, filter),
      getTranslations({ locale, namespace: 'accounting.cashUp.csv' }),
      getTranslations({ locale, namespace: 'orders.method' }),
    ]);
    const body = buildCsv(
      [
        t('seller'),
        t('method'),
        t('currency'),
        t('orders'),
        t('tickets'),
        t('gross'),
        t('received'),
        t('refunded'),
        t('net'),
        t('refundedOrders'),
        t('refundsOpen'),
        t('cancelledOrders'),
      ],
      [
        ...report.lines.map((l) => [
          l.sellerName ?? t('unknownSeller'),
          tMethod(l.method),
          l.currency,
          l.orders,
          l.tickets,
          formatCsvAmount(l.sales),
          formatCsvAmount(l.gross),
          formatCsvAmount(l.refunded),
          formatCsvAmount(l.gross - l.refunded),
          l.refundedOrders,
          formatCsvAmount(l.refundsOpen),
          l.cancelledOrders,
        ]),
        // One total row per currency (amounts of different currencies are never added up).
        ...report.totals.map(({ currency, totals }) => [
          t('total'),
          '',
          currency,
          totals.orders,
          totals.tickets,
          formatCsvAmount(totals.sales),
          formatCsvAmount(totals.gross),
          formatCsvAmount(totals.refunded),
          formatCsvAmount(totals.net),
          totals.refundedOrders,
          formatCsvAmount(totals.refundsOpen),
          totals.cancelledOrders,
        ]),
      ],
    );
    await audit(core.db, session, 'cash_up.export', 'cash_up', null, {
      from: filter.from,
      to: filter.to,
      eventId: filter.eventId ?? null,
      sellerUserId: filter.sellerUserId ?? null,
      rows: report.lines.length,
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="cash-up-${filter.from}_${filter.to}.csv"`,
        'cache-control': 'no-store',
      },
    });
  });
}
