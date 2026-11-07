import { ArrowLeft } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ReviewCase } from '@/components/admin/banking/review-case';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { getTransactionDetail, toReviewCaseView } from '@/server/admin/banking-queries';

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [t, format, detail] = await Promise.all([
    getTranslations('banking'),
    getFormatter(),
    getTransactionDetail(id),
  ]);
  if (!detail) notFound();
  const tx = detail.tx;
  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: 'medium' }) : '–';
  const source = detail.importFile
    ? `${t('source.UPLOAD')}: ${detail.importFile}`
    : (detail.connectionName ?? '–');
  const rows: [string, string | null][] = [
    [t('transactions.fields.bookingDate'), date(tx.bookingDate)],
    [t('transactions.fields.valueDate'), date(tx.valueDate)],
    [t('transactions.fields.counterparty'), tx.counterpartyName],
    [t('transactions.fields.iban'), tx.counterpartyIban],
    [t('transactions.fields.bic'), tx.counterpartyBic],
    [t('transactions.fields.endToEndId'), tx.endToEndId],
    [t('transactions.fields.externalId'), tx.externalId],
    [t('transactions.fields.code'), tx.bankTransactionCode],
    [t('transactions.fields.account'), detail.accountName],
    [t('transactions.fields.source'), source],
    [
      t('transactions.fields.reviewedAt'),
      tx.reviewedAt
        ? format.dateTime(tx.reviewedAt, { dateStyle: 'medium', timeStyle: 'short' })
        : null,
    ],
    [t('transactions.fields.note'), tx.reviewNote],
  ];
  return (
    <>
      <Button asChild variant="ghost" size="sm">
        <Link href="/admin/banking/transactions">
          <ArrowLeft /> {t('transactions.backToList')}
        </Link>
      </Button>
      <ReviewCase view={toReviewCaseView(detail)} showDetailsLink={false} />
      <Card>
        <CardHeader>
          <CardTitle>{t('review.details')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-words">{value ?? '–'}</dd>
              </div>
            ))}
          </dl>
          {detail.importId ? (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/admin/banking/imports/${detail.importId}`}>{t('imports.download')}</a>
            </Button>
          ) : null}
          {tx.rawData ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {t('transactions.fields.raw')}
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
                {JSON.stringify(tx.rawData, null, 2)}
              </pre>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
