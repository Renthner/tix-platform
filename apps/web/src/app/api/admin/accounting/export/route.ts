import {
  buildAccountingCsv,
  buildDatevExport,
  getSetting,
  loadAccountingData,
  validateRange,
  type CsvKind,
} from '@tix/core';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { routing } from '@/i18n/routing';
import { audit } from '@/server/admin/audit';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  kind: z.enum(['documents', 'payments', 'refunds', 'datev']),
  from: z.string(),
  to: z.string(),
  locale: z.string().optional(),
});

/**
 * GET – accounting export for the tax advisor. `kind` = `documents` | `payments` | `refunds`
 * (simple CSV: UTF-8 BOM, `;`, decimal comma) or `datev` (Buchungsstapel EXTF 700, Windows-1252).
 * Dates are inclusive local dates in the shop time zone. Every export is audited with range,
 * kind and row count only.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['FINANCE']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const range = { from: query.from, to: query.to };
    validateRange(range);
    const locale = hasLocale(routing.locales, query.locale) ? query.locale : routing.defaultLocale;
    const t = await getTranslations({ locale, namespace: 'accounting' });
    const core = getCore();
    const [general, settings] = await Promise.all([
      getSetting(core, 'general'),
      getSetting(core, 'accounting'),
    ]);
    const timeZone = general.defaultTimeZone;
    const name = `${query.from}_${query.to}`;
    let body: string | Buffer;
    let rows: number;
    let headers: Record<string, string>;

    if (query.kind === 'datev') {
      const data = await loadAccountingData(core.db, range, timeZone);
      const built = buildDatevExport(
        data,
        settings,
        range,
        {
          invoice: t('datev.invoice'),
          creditNote: t('datev.creditNote'),
          payment: t('datev.payment'),
          paymentReversal: t('datev.paymentReversal'),
          writeOff: t('datev.writeOff'),
          writeOffReversal: t('datev.writeOffReversal'),
          refund: t('datev.refund'),
          description: t('datev.description', {
            from: query.from.slice(2).replaceAll('-', ''),
            to: query.to.slice(2).replaceAll('-', ''),
          }),
          exportedBy: t('datev.exportedBy'),
        },
        timeZone,
      );
      body = built.body;
      rows = built.rows;
      headers = {
        'content-type': 'text/csv; charset=windows-1252',
        'content-disposition': `attachment; filename="EXTF_Buchungsstapel_${name}.csv"`,
      };
    } else {
      const kind: CsvKind = query.kind;
      const data = await loadAccountingData(core.db, range, timeZone, [kind]);
      const labels: Record<string, string> = {
        number: t('csv.number'),
        type: t('csv.type'),
        date: t('csv.date'),
        corrects: t('csv.corrects'),
        order: t('csv.order'),
        buyerName: t('csv.buyerName'),
        buyerCompany: t('csv.buyerCompany'),
        net: t('csv.net'),
        taxRate: t('csv.taxRate'),
        tax: t('csv.tax'),
        gross: t('csv.gross'),
        currency: t('csv.currency'),
        paymentMethod: t('csv.paymentMethod'),
        orderStatus: t('csv.orderStatus'),
        invoice: t('csv.invoice'),
        method: t('csv.method'),
        amount: t('csv.amount'),
        reference: t('csv.reference'),
        providerId: t('csv.providerId'),
        overpayment: t('csv.overpayment'),
        creditNote: t('csv.creditNote'),
        kind: t('csv.kind'),
        status: t('csv.status'),
        note: t('csv.note'),
      };
      const built = buildAccountingCsv(kind, data, labels, timeZone);
      body = built.body;
      rows = built.rows;
      headers = {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="accounting-${kind}-${name}.csv"`,
      };
    }

    await audit(core.db, session, 'accounting.export', 'accounting', null, {
      kind: query.kind,
      from: query.from,
      to: query.to,
      rows,
    });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      headers: { ...headers, 'x-export-rows': String(rows), 'cache-control': 'no-store' },
    });
  });
}
