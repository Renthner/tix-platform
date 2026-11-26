import { Download } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { BankingPage } from '@/components/admin/banking/banking-page';
import { ReviewCase } from '@/components/admin/banking/review-case';
import { DetailLayout, DetailSection } from '@/components/admin/detail-layout';
import { Button } from '@/components/ui/button';
import { bankTxHold } from '@/lib/banking-hold';
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
  const amount = format.number(tx.amount / 100, {
    style: 'currency',
    currency: tx.currency,
    signDisplay: 'exceptZero',
  });
  return (
    <BankingPage
      title={`${t('transactions.detailTitle')} · ${amount}`}
      description={`${date(tx.bookingDate)} · ${tx.counterpartyName ?? '–'} · ${detail.accountName}`}
      trail={[{ label: t('tabs.transactions'), href: '/admin/banking/transactions' }]}
      actions={
        detail.importId ? (
          <Button asChild variant="outline">
            <a href={`/api/admin/banking/imports/${detail.importId}`}>
              <Download /> {t('imports.download')}
            </a>
          </Button>
        ) : undefined
      }
    >
      <DetailLayout
        className="p-0"
        aside={
          <DetailSection title={t('review.details')}>
            <dl className="space-y-2 text-sm">
              {rows.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="break-words">{value ?? '–'}</dd>
                </div>
              ))}
            </dl>
          </DetailSection>
        }
      >
        <ReviewCase
          view={toReviewCaseView(detail)}
          showDetailsLink={false}
          hold={bankTxHold(tx.rawData)}
        />
        {tx.rawData ? (
          <DetailSection title={t('transactions.fields.raw')}>
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {t('transactions.showRaw')}
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
                {JSON.stringify(tx.rawData, null, 2)}
              </pre>
            </details>
          </DetailSection>
        ) : null}
      </DetailLayout>
    </BankingPage>
  );
}
