import {
  listInvoiceCorrections,
  listOpenAdjustments,
  listOpenRefunds,
  getRefundReconcileStatus,
  listRefundRestoreReviews,
} from '@tix/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import {
  RepairInvoiceButton,
  ResetTariffButton,
  RecordExistingRefundForm,
  ResolveRestoreReviewButton,
  SkipReconciliationForm,
} from '@/components/admin/adjustment-actions';
import { RefundBatchList, type RefundBatchData } from '@/components/admin/refund-batches';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('orders.admin.refundsPage');
  return { title: t('title') };
}

export default async function OpenRefundsPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const session = await requireAdmin(['FINANCE']);
  const [t, format, rows, adjustments, ta, corrections, reviews, reconcile] = await Promise.all([
    getTranslations('orders.admin.refundsPage'),
    getFormatter(),
    listOpenRefunds(getCore()),
    listOpenAdjustments(getCore()),
    getTranslations('orders.admin.adjustmentsPage'),
    listInvoiceCorrections(getCore()),
    listRefundRestoreReviews(getCore()),
    getRefundReconcileStatus(getCore()),
  ]);

  const batches: RefundBatchData[] = rows.map((r) => ({
    ...r,
    order: { id: r.orderId, number: r.orderNumber, customer: r.customerName, email: r.email },
  }));
  const money = (cents: number, currency: string) =>
    format.number(cents / 100, { style: 'currency', currency });
  const date = (d: Date) => format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' });
  // Shared grid of the two smaller lists: stacked on small screens, columns from md.
  const listClass = 'divide-y rounded-md border';
  const rowClass = 'grid gap-x-4 gap-y-2 p-4 md:items-center';

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-6 p-6">
        <Card>
          <CardContent className="space-y-3 pt-6">
            {rows.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <RefundBatchList batches={batches} canAct />
            )}
          </CardContent>
        </Card>

        {reconcile.pending && (
          <Card className="border-destructive/50">
            <CardContent className="space-y-2 pt-6 text-sm">
              <h2 className="text-base font-semibold">{t('reconcile.title')}</h2>
              <p className="text-muted-foreground">
                {reconcile.lastError || reconcile.alert
                  ? t('reconcile.failing', { attempts: reconcile.attempts })
                  : t('reconcile.pending')}
              </p>
              {reconcile.alert === 'MOSTLY_NOT_FOUND' && (
                <p className="font-medium text-destructive">{t('reconcile.mostlyNotFound')}</p>
              )}
              {reconcile.lastError && (
                <p className="font-mono text-xs">
                  {t('reconcile.lastError', { error: reconcile.lastError })}
                </p>
              )}
              {hasRole(session, ['SUPER_ADMIN']) && <SkipReconciliationForm />}
            </CardContent>
          </Card>
        )}

        {reviews.length > 0 && (
          <Card className="border-destructive/50">
            <CardContent className="space-y-3 pt-6">
              <div>
                <h2 className="text-base font-semibold">{t('restoreReview.title')}</h2>
                <p className="text-sm text-muted-foreground">{t('restoreReview.description')}</p>
              </div>
              <ul className={listClass}>
                {reviews.map((r) => (
                  <li
                    key={r.orderId}
                    className={`${rowClass} md:grid-cols-[minmax(9rem,12rem)_minmax(10rem,1fr)_minmax(12rem,auto)]`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <Link
                        href={`/admin/orders/${r.orderId}`}
                        className="font-medium hover:underline"
                      >
                        {r.orderNumber}
                      </Link>
                      <div className="truncate">{r.buyerName}</div>
                      <div className="whitespace-nowrap text-xs text-muted-foreground">
                        {date(r.createdAt)}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <ul className="space-y-1 text-sm">
                        {r.findings.map((f) => (
                          <li key={`${f.kind}:${f.ref}`}>
                            {t(`restoreReview.kinds.${f.kind}`, {
                              amount: f.currency ? money(f.amount, f.currency) : '',
                              ref: f.ref,
                              detail: f.detail ?? '',
                            })}
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">{t('restoreReview.hold')}</p>
                      {
                        <RecordExistingRefundForm
                          orderId={r.orderId}
                          defaultRefundId={
                            (
                              r.findings.find(
                                (f) =>
                                  f.kind === 'UNKNOWN_AT_PAYPAL' ||
                                  f.kind === 'EXTERNAL_REFUND_NOTICE',
                              ) ?? r.findings[0]
                            )?.ref ?? ''
                          }
                          items={r.items}
                          money={Object.fromEntries(
                            r.items.map((i) => [i.id, money(i.priceGross, r.currency)]),
                          )}
                        />
                      }
                    </div>
                    <div className="md:flex md:justify-end">
                      <ResolveRestoreReviewButton orderId={r.orderId} />
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="space-y-3 pt-6">
            <div>
              <h2 className="text-base font-semibold">{ta('title')}</h2>
              <p className="text-sm text-muted-foreground">{ta('description')}</p>
            </div>
            {adjustments.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">{ta('empty')}</p>
            ) : (
              <ul className={listClass}>
                {adjustments.map((a) => (
                  <li
                    key={a.id}
                    className={`${rowClass} md:grid-cols-[minmax(9rem,12rem)_9rem_minmax(10rem,1fr)_minmax(12rem,auto)]`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <Link
                        href={`/admin/orders/${a.orderId}`}
                        className="font-medium hover:underline"
                      >
                        {a.orderNumber}
                      </Link>
                      <div className="truncate">{a.buyerName}</div>
                      <div className="truncate text-xs text-muted-foreground">{a.email}</div>
                    </div>
                    <div className="space-y-0.5 md:text-right">
                      <div className="text-base font-semibold tabular-nums">
                        {money(a.amount, a.currency)}
                      </div>
                      {a.creditApplied > 0 && (
                        <div className="text-xs text-muted-foreground">
                          {ta('creditIncluded', { credit: money(a.creditApplied, a.currency) })}
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Badge variant={a.needsAttention ? 'destructive' : 'secondary'}>
                        {ta(`statuses.${a.status as 'PROPOSED' | 'CONFIRMED'}`)}
                      </Badge>
                      {a.reminderSentAt && (
                        <div className="text-xs text-muted-foreground">
                          {ta('reminderSent', {
                            date: format.dateTime(a.reminderSentAt, { dateStyle: 'medium' }),
                          })}
                        </div>
                      )}
                      <div className="whitespace-nowrap text-xs text-muted-foreground">
                        {date(a.createdAt)}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                      <ResetTariffButton adjustmentId={a.id} />
                      <Link href={`/admin/orders/${a.orderId}`} className="text-sm underline">
                        {ta('openOrder')}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {corrections.length > 0 && (
          <Card>
            <CardContent className="space-y-3 pt-6">
              <div>
                <h2 className="text-base font-semibold">{ta('corrections.title')}</h2>
                <p className="text-sm text-muted-foreground">{ta('corrections.description')}</p>
              </div>
              <ul className={listClass}>
                {corrections.map((c) => (
                  <li
                    key={c.orderId}
                    className={`${rowClass} md:grid-cols-[minmax(9rem,12rem)_minmax(10rem,1fr)_9rem_minmax(12rem,auto)]`}
                  >
                    <Link
                      href={`/admin/orders/${c.orderId}`}
                      className="font-medium hover:underline"
                    >
                      {c.orderNumber}
                    </Link>
                    <div className="truncate">{c.buyerName}</div>
                    <div className="font-medium tabular-nums md:text-right">
                      {money(c.amount, c.currency)}
                    </div>
                    <div className="md:flex md:justify-end">
                      <RepairInvoiceButton orderId={c.orderId} />
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
