import { getAnonymizationBlockers, getCustomerAdminView, getSetting, hasBlockers } from '@tix/core';
import { SUPPORTED_LOCALES } from '@tix/shared';
import { Receipt } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AnonymizeForm, CustomerProfileForm } from '@/components/admin/customers/customer-forms';
import { CustomerHeaderActions } from '@/components/admin/customers/customer-header-actions';
import { DetailLayout, DetailSection } from '@/components/admin/detail-layout';
import { EmptyState } from '@/components/admin/empty-state';
import { EntityAuditCard } from '@/components/admin/entity-audit-card';
import { OrderStatusBadge } from '@/components/admin/order-badges';
import { AdminPageHeader } from '@/components/admin/page-header';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('customers');
  return { title: t('detailTitle') };
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const core = getCore();
  const view = await getCustomerAdminView(core, id);
  if (!view) notFound();
  const { customer } = view;
  const anonymized = customer.anonymizedAt !== null;
  const canErase = hasRole(session, ['FINANCE']);
  const [t, tl, format, privacy, general, organizer, blockers] = await Promise.all([
    getTranslations('customers'),
    getTranslations('common.locale'),
    getFormatter(),
    getSetting(core, 'privacy'),
    getSetting(core, 'general'),
    getSetting(core, 'organizer'),
    anonymized ? null : getAnonymizationBlockers(core.db, id, customer.email),
  ]);
  const money = (cents: number, currency = general.defaultCurrency) =>
    format.number(cents / 100, { style: 'currency', currency });
  const date = (d: Date | null) =>
    d ? format.dateTime(new Date(d), { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  const address = customer.address;
  const dl = 'grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm';
  const dt = 'text-muted-foreground';

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[{ label: t('title'), href: '/admin/customers' }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {anonymized ? t('anonymizedName') : `${customer.firstName} ${customer.lastName}`}
            {anonymized && <Badge variant="secondary">{t('anonymized')}</Badge>}
          </span>
        }
        description={anonymized ? undefined : customer.email}
        actions={
          <CustomerHeaderActions
            customerId={id}
            hasAccount={customer.hasAccount}
            verified={customer.emailVerifiedAt !== null}
            locked={customer.locked}
            anonymized={anonymized}
            exportHref={canErase ? `/api/admin/customers/${id}/export` : null}
          />
        }
      />
      <DetailLayout
        aside={
          <>
            <DetailSection title={t('account.title')} data-testid="customer-account">
              <dl className={dl}>
                <dt className={dt}>{t('account.status')}</dt>
                <dd>{customer.hasAccount ? t('account.hasAccount') : t('account.guest')}</dd>
                <dt className={dt}>{t('account.verifiedLabel')}</dt>
                <dd>
                  {customer.emailVerifiedAt ? date(customer.emailVerifiedAt) : t('account.no')}
                </dd>
                <dt className={dt}>{t('account.lastLogin')}</dt>
                <dd>{date(customer.lastLoginAt)}</dd>
                <dt className={dt}>{t('account.locked')}</dt>
                <dd>
                  {customer.locked
                    ? t('account.lockedUntil', { date: date(customer.lockedUntil) })
                    : t('account.no')}
                </dd>
                <dt className={dt}>{t('account.marketing')}</dt>
                <dd>
                  {customer.marketingConsentAt
                    ? date(customer.marketingConsentAt)
                    : t('account.no')}
                </dd>
                <dt className={dt}>{t('account.created')}</dt>
                <dd>{date(customer.createdAt)}</dd>
              </dl>
            </DetailSection>
            <DetailSection
              title={t('gdpr.title')}
              description={t('gdpr.description')}
              contentClassName="space-y-4 text-sm"
              data-testid="customer-gdpr"
            >
              {canErase && !anonymized && blockers && (
                <div className="space-y-3">
                  <div className="font-medium">{t('anonymize.title')}</div>
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <p>{t('anonymize.erased')}</p>
                    <p>{t('anonymize.kept', { years: privacy.invoiceRetentionYears })}</p>
                  </div>
                  {hasBlockers(blockers) ? (
                    <div className="space-y-2" role="alert">
                      <p className="font-medium text-destructive">{t('anonymize.blocked')}</p>
                      <ul className="list-disc space-y-1 pl-5">
                        {blockers.openOrders.map((o) => (
                          <li key={`o-${o.orderId}`}>
                            <Link href={`/admin/orders/${o.orderId}`} className="underline">
                              {o.orderNumber}
                            </Link>{' '}
                            – {t('anonymize.openOrder')}
                          </li>
                        ))}
                        {blockers.futureTickets.map((o) => (
                          <li key={`t-${o.orderId}-${o.eventTitle}`}>
                            <Link href={`/admin/orders/${o.orderId}`} className="underline">
                              {o.orderNumber}
                            </Link>{' '}
                            –{' '}
                            {t('anonymize.futureTickets', {
                              count: o.tickets,
                              event: o.eventTitle,
                              date: format.dateTime(new Date(o.startsAt), { dateStyle: 'medium' }),
                            })}
                          </li>
                        ))}
                        {blockers.openRefunds.map((r) => (
                          <li key={`r-${r.refundId}`}>
                            <Link href={`/admin/orders/${r.orderId}`} className="underline">
                              {r.orderNumber}
                            </Link>{' '}
                            – {t('anonymize.openRefund', { amount: money(r.amount) })}
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">{t('anonymize.cancelFirst')}</p>
                    </div>
                  ) : (
                    <AnonymizeForm customerId={id} email={customer.email} />
                  )}
                </div>
              )}
              {anonymized && (
                <p className="text-muted-foreground">
                  {t('anonymize.done', { date: date(customer.anonymizedAt) })}
                </p>
              )}
              {!canErase && !anonymized && (
                <p className="text-muted-foreground">{t('gdpr.financeOnly')}</p>
              )}
            </DetailSection>
            <EntityAuditCard
              entityType="customer"
              entityId={id}
              showFullLogLink={hasRole(session, ['SUPER_ADMIN'])}
            />
          </>
        }
      >
        <DetailSection
          title={t('profile.title')}
          description={anonymized ? t('profile.anonymizedNote') : undefined}
        >
          <CustomerProfileForm
            customerId={id}
            disabled={anonymized}
            locales={SUPPORTED_LOCALES.map((l) => ({ value: l, label: tl(l) }))}
            initial={{
              firstName: customer.firstName,
              lastName: customer.lastName,
              email: anonymized ? '' : customer.email,
              company: customer.company ?? '',
              phone: customer.phone ?? '',
              locale: customer.locale ?? '',
              street: address?.street ?? '',
              addressLine2: address?.addressLine2 ?? '',
              postalCode: address?.postalCode ?? '',
              city: address?.city ?? '',
              country: address?.country ?? organizer.country,
            }}
          />
        </DetailSection>
        <DetailSection
          title={t('orders.title')}
          description={t('orders.summary', {
            count: view.orders.length,
            revenue: money(view.revenue),
          })}
          contentClassName={view.orders.length === 0 ? undefined : 'p-0'}
          data-testid="customer-orders"
        >
          {view.orders.length === 0 ? (
            <EmptyState icon={Receipt} size="sm" title={t('orders.empty')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('orders.number')}</TableHead>
                  <TableHead>{t('orders.date')}</TableHead>
                  <TableHead>{t('orders.status')}</TableHead>
                  <TableHead className="text-right">{t('orders.total')}</TableHead>
                  <TableHead>{t('orders.retention')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono">
                      <Link href={`/admin/orders/${order.id}`} className="hover:underline">
                        {order.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{date(order.createdAt)}</TableCell>
                    <TableCell>
                      <OrderStatusBadge status={order.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(order.totalGross, order.currency)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {order.personalDataRetainedUntil
                        ? t('orders.retainedUntil', {
                            date: format.dateTime(new Date(order.personalDataRetainedUntil), {
                              dateStyle: 'medium',
                            }),
                          })
                        : order.anonymizedAt
                          ? t('orders.erased')
                          : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DetailSection>
      </DetailLayout>
    </>
  );
}
