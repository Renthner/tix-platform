import { exportDiscountCodesCsv, getSetting } from '@tix/core';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { routing } from '@/i18n/routing';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ batch: z.uuid().optional(), locale: z.string().optional() });

/** GET – CSV of discount codes (all, or one generated batch) for printing / distribution. */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER', 'FINANCE']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const locale = hasLocale(routing.locales, query.locale) ? query.locale : routing.defaultLocale;
    const t = await getTranslations({ locale, namespace: 'discounts' });
    const core = getCore();
    const general = await getSetting(core, 'general');
    const { csv, rows } = await exportDiscountCodesCsv(
      core.db,
      { batchId: query.batch },
      {
        header: t.raw('csv.header') as string[],
        types: { FIXED: t('types.FIXED'), PERCENT: t('types.PERCENT') },
        yes: t('csv.yes'),
        no: t('csv.no'),
      },
      general.defaultTimeZone,
    );
    await audit(core.db, session, 'discount.export', 'discount_code', null, {
      rows,
      batchId: query.batch ?? null,
    });
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="discount-codes${query.batch ? '-batch' : ''}.csv"`,
        'cache-control': 'no-store',
      },
    });
  });
}
