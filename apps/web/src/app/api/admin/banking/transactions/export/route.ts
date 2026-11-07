import { getTranslations } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from '@/i18n/routing';
import {
  allocatedOrderNumbers,
  exportTransactions,
  parseTransactionFilters,
} from '@/server/admin/banking-queries';
import { adminForApi } from '@/server/auth';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * GET – CSV export of the (filtered) bank transactions for accounting: semicolon separated,
 * UTF-8 with BOM, one line per booking incl. match status and assigned order numbers.
 * `?locale=de` switches headers and decimal comma.
 */
export async function GET(request: Request) {
  return handle(async () => {
    if (!(await adminForApi(['FINANCE']))) return apiError('FORBIDDEN', 'Not allowed', 403);
    const url = new URL(request.url);
    const sp = Object.fromEntries(url.searchParams.entries());
    const locale = hasLocale(routing.locales, sp.locale) ? sp.locale : routing.defaultLocale;
    const t = await getTranslations({ locale, namespace: 'banking' });
    const rows = await exportTransactions(parseTransactionFilters(sp));
    const orderNumbers = await allocatedOrderNumbers(rows.map((r) => r.tx.id));
    const decimal = locale === 'de' ? ',' : '.';
    const cell = (value: string | number | null | undefined) => {
      const s = value === null || value === undefined ? '' : String(value);
      return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      t('export.bookingDate'),
      t('export.valueDate'),
      t('export.amount'),
      t('export.currency'),
      t('export.counterpartyName'),
      t('export.counterpartyIban'),
      t('export.remittance'),
      t('export.endToEndId'),
      t('export.account'),
      t('export.accountIban'),
      t('export.status'),
      t('export.reason'),
      t('export.reference'),
      t('export.orders'),
      t('export.note'),
    ];
    const lines = rows.map(({ tx, accountName, iban }) =>
      [
        tx.bookingDate,
        tx.valueDate,
        (tx.amount / 100).toFixed(2).replace('.', decimal),
        tx.currency,
        tx.counterpartyName,
        tx.counterpartyIban,
        tx.remittanceInformation,
        tx.endToEndId,
        accountName,
        iban,
        t(`status.${tx.matchStatus}`),
        tx.reviewReason ? t(`reason.${tx.reviewReason}`) : '',
        tx.extractedReference,
        (orderNumbers.get(tx.id) ?? []).join(', '),
        tx.reviewNote,
      ]
        .map(cell)
        .join(';'),
    );
    const body = `﻿${[header.map(cell).join(';'), ...lines].join('\r\n')}\r\n`;
    const date = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="bank-transactions-${date}.csv"`,
        'cache-control': 'no-store',
      },
    });
  });
}
