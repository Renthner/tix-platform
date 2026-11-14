import { buildCsv, formatCsvAmount, getSalesStatistics, parseStatisticsParams } from '@tix/core';
import de from '../../../../../../messages/de/statistics.json';
import en from '../../../../../../messages/en/statistics.json';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – the time series of the filtered statistics as CSV (same filter parameters as the page). */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER', 'FINANCE']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const url = new URL(request.url);
    const params = Object.fromEntries(
      [...new Set(url.searchParams.keys())].map((k) => [k, url.searchParams.getAll(k)]),
    );
    const data = await getSalesStatistics(getCore(), parseStatisticsParams(params));
    const locale = url.searchParams.get('locale') === 'de' ? 'de' : 'en';
    const t = (key: keyof typeof en.csv) => (locale === 'de' ? de : en).csv[key];
    const csv = buildCsv(
      [
        t('bucket'),
        `${t('revenue')} (${data.currency})`,
        t('tickets'),
        t('orders'),
        `${t('refunds')} (${data.currency})`,
        t('refundedTickets'),
        t('newOrders'),
        t('returningOrders'),
      ],
      data.series.map((p) => [
        { raw: p.bucket },
        formatCsvAmount(p.revenue),
        p.tickets,
        p.orders,
        formatCsvAmount(p.refunds),
        p.refundedTickets,
        p.newCustomerOrders,
        p.returningCustomerOrders,
      ]),
    );
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="statistics-${data.range.from}_${data.range.to}.csv"`,
        'cache-control': 'no-store',
      },
    });
  });
}
