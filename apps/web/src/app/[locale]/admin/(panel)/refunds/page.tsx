import {
  listInvoiceCorrections,
  listOpenAdjustments,
  listOpenRefunds,
  getRefundReconcileStatus,
  listRefundRestoreReviews,
} from '@tix/core';
import { CheckCircle2 } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { DetailLayout, DetailSection } from '@/components/admin/detail-layout';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminPageHeader } from '@/components/admin/page-header';
import {
  RepairInvoiceButton,
  ResetTariffButton,
  RecordExistingRefundForm,
  ResolveRestoreReviewButton,
  ReconcileNowForm,
  SkipReconciliationForm,
} from '@/components/admin/adjustment-actions';
import { RefundBatchList, type RefundBatchData } from '@/components/admin/refund-batches';
import { Badge } from '@/components/ui/badge';
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
  // Shared grid of the smaller lists: stacked on small screens, columns from md.
  const listClass = 'divide-y rounded-md border';
  const rowClass = 'grid gap-x-4 gap-y-2 p-4 md:items-center';

  return (
    <>
      <AdminPageHeader title={t('title')} description={t('description')} />
      {/* One column: the lists are wide grids; alerts first, the manual reconcile last. */}
      <DetailLayout>
        {reconcile.pending && (
          <DetailSection
            title={t('reconcile.title')}
            description={
              reconcile.lastError || reconcile.alert
                ? t('reconcile.failing', { attempts: reconcile.attempts })
                : t('reconcile.pending')
            }
            className="border-destructive/50"
            contentClassName="space-y-2 text-sm"
            data-testid="refunds-reconcile"
          >
            {reconcile.alert === 'MOSTLY_NOT_FOUND' && (
              <p className="font-medium text-destructive">{t('reconcile.mostlyNotFound')}</p>
            )}
            {reconcile.alert === 'PAYPAL_NOT_CONFIGURED' && (
              <p className="font-medium text-destructive">{t('reconcile.notConfigured')}</p>
            )}
            {reconcile.alert === 'PAYPAL_CREDENTIALS' && (
              <p className="font-medium text-destructive">{t('reconcile.credentials')}</p>
            )}
            {reconcile.lastError && (
              <p className="font-mono text-xs">
                {t('reconcile.lastError', { error: reconcile.lastError })}
              </p>
            )}
            <ReconcileNowForm pending />
            {hasRole(session, ['SUPER_ADMIN']) && <SkipReconciliationForm />}
          </DetailSection>
        )}

        {reviews.length > 0 && (
          <DetailSection
            title={t('restoreReview.title')}
            description={t('restoreReview.description')}
            className="border-destructive/50"
            data-testid="refunds-restore-review"
          >
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
                    <div className="text-xs whitespace-nowrap text-muted-foreground">
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
                    <RecordExistingRefundForm
                      orderId={r.orderId}
                      defaultRefundId={
                        (
                          r.findings.find(
                            (f) =>
                              f.kind === 'UNKNOWN_AT_PAYPAL' || f.kind === 'EXTERNAL_REFUND_NOTICE',
                          ) ?? r.findings[0]
                        )?.ref ?? ''
                      }
                      items={r.items}
                      money={Object.fromEntries(
                        r.items.map((i) => [i.id, money(i.priceGross, r.currency)]),
                      )}
                    />
                  </div>
                  <div className="md:flex md:justify-end">
                    <ResolveRestoreReviewButton orderId={r.orderId} />
                  </div>
                </li>
              ))}
            </ul>
          </DetailSection>
        )}

        <DetailSection
          title={t('listTitle')}
          contentClassName="space-y-3"
          data-testid="refunds-open"
        >
          {rows.length === 0 ? (
            <EmptyState icon={CheckCircle2} size="sm" tone="success" title={t('empty')} />
          ) : (
            <RefundBatchList batches={batches} canAct />
          )}
        </DetailSection>

        <DetailSection
          title={ta('title')}
          description={ta('description')}
          data-testid="refunds-adjustments"
        >
          {adjustments.length === 0 ? (
            <EmptyState icon={CheckCircle2} size="sm" tone="success" title={ta('empty')} />
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
                    <div className="text-xs whitespace-nowrap text-muted-foreground">
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
        </DetailSection>

        {corrections.length > 0 && (
          <DetailSection
            title={ta('corrections.title')}
            description={ta('corrections.description')}
            data-testid="refunds-corrections"
          >
            <ul className={listClass}>
              {corrections.map((c) => (
                <li
                  key={c.orderId}
                  className={`${rowClass} md:grid-cols-[minmax(9rem,12rem)_minmax(10rem,1fr)_9rem_minmax(12rem,auto)]`}
                >
                  <Link href={`/admin/orders/${c.orderId}`} className="font-medium hover:underline">
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
          </DetailSection>
        )}
        {!reconcile.pending && (
          <DetailSection
            title={t('reconcile.manualTitle')}
            description={t('reconcile.manualText')}
            data-testid="refunds-reconcile"
          >
            <ReconcileNowForm pending={false} />
          </DetailSection>
        )}
      </DetailLayout>
    </>
  );
}
