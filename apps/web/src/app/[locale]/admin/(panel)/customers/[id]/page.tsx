import { getAnonymizationBlockers, getCustomerAdminView, getSetting, hasBlockers } from '@tix/core';
import { SUPPORTED_LOCALES } from '@tix/shared';
import { ArrowLeft, Download } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  AccountActions,
  AnonymizeForm,
  CustomerProfileForm,
} from '@/components/admin/customers/customer-forms';
import { OrderStatusBadge } from '@/components/admin/order-badges';
import { PageHeader } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {anonymized ? t('anonymizedName') : `${customer.firstName} ${customer.lastName}`}
            {anonymized && <Badge variant="secondary">{t('anonymized')}</Badge>}
          </span>
        }
        description={anonymized ? undefined : customer.email}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/customers">
              <ArrowLeft /> {t('backToList')}
            </Link>
          </Button>
        }
      />
      <div className="grid gap-6 p-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('profile.title')}</CardTitle>
              {anonymized && <CardDescription>{t('profile.anonymizedNote')}</CardDescription>}
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('orders.title')}</CardTitle>
              <CardDescription>
                {t('orders.summary', { count: view.orders.length, revenue: money(view.revenue) })}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
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
                  {view.orders.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                        {t('orders.empty')}
                      </TableCell>
                    </TableRow>
                  )}
                  {view.orders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell className="font-mono">
                        <Link href={`/admin/orders/${order.id}`} className="hover:underline">
                          {order.orderNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{date(order.createdAt)}</TableCell>
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
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('account.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('account.status')}</dt>
                <dd>{customer.hasAccount ? t('account.hasAccount') : t('account.guest')}</dd>
                <dt className="text-muted-foreground">{t('account.verifiedLabel')}</dt>
                <dd>
                  {customer.emailVerifiedAt ? date(customer.emailVerifiedAt) : t('account.no')}
                </dd>
                <dt className="text-muted-foreground">{t('account.lastLogin')}</dt>
                <dd>{date(customer.lastLoginAt)}</dd>
                <dt className="text-muted-foreground">{t('account.locked')}</dt>
                <dd>
                  {customer.locked
                    ? t('account.lockedUntil', { date: date(customer.lockedUntil) })
                    : t('account.no')}
                </dd>
                <dt className="text-muted-foreground">{t('account.marketing')}</dt>
                <dd>
                  {customer.marketingConsentAt
                    ? date(customer.marketingConsentAt)
                    : t('account.no')}
                </dd>
                <dt className="text-muted-foreground">{t('account.created')}</dt>
                <dd>{date(customer.createdAt)}</dd>
              </dl>
              <AccountActions
                customerId={id}
                hasAccount={customer.hasAccount}
                verified={customer.emailVerifiedAt !== null}
                locked={customer.locked}
                anonymized={anonymized}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('gdpr.title')}</CardTitle>
              <CardDescription>{t('gdpr.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {canErase && (
                <Button asChild variant="outline">
                  <a href={`/api/admin/customers/${id}/export`} download>
                    <Download /> {t('gdpr.export')}
                  </a>
                </Button>
              )}
              {canErase && !anonymized && blockers && (
                <div className="space-y-3 rounded-md border p-3">
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
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
