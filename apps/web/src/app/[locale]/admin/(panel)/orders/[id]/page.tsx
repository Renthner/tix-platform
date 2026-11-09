import { getOrderAdminView, orderUrl, resendableEmail } from '@tix/core';
import { formatTicketCode } from '@tix/shared';
import { ArrowLeft, Download, ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { OrderAdminActions } from '@/components/admin/order-actions';
import { OrderStatusBadge } from '@/components/admin/order-badges';
import { PageHeader } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  const t = await getTranslations('orders.admin');
  return { title: t('detailTitle') };
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const core = getCore();
  const view = await getOrderAdminView(core, id);
  if (!view) notFound();
  const { order } = view;
  const [t, tMethod, tPayment, tStatus, format] = await Promise.all([
    getTranslations('orders.admin'),
    getTranslations('orders.method'),
    getTranslations('orders.paymentStatus'),
    getTranslations('orders.status'),
    getFormatter(),
  ]);
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: order.currency });
  const dateTime = (d: Date | string | null) =>
    d ? format.dateTime(new Date(d), { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  const open = order.status === 'PENDING' || order.status === 'AWAITING_PAYMENT';
  const address = order.billingAddress;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t('detailHeading', { number: order.orderNumber })}{' '}
            <OrderStatusBadge status={order.status} />
          </span>
        }
        description={`${dateTime(order.createdAt)} · ${tMethod(order.paymentMethod)} · ${money(order.totalGross)}`}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <a href={orderUrl(core, order)} target="_blank" rel="noopener">
                <ExternalLink /> {t('customerView')}
              </a>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/orders">
                <ArrowLeft /> {t('backToList')}
              </Link>
            </Button>
          </div>
        }
      />
      <div className="grid gap-6 p-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('buyer.title')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="font-medium">
                  {order.firstName} {order.lastName}
                </div>
                {order.company && <div>{order.company}</div>}
                <div>
                  <a href={`mailto:${order.email}`} className="hover:underline">
                    {order.email}
                  </a>
                </div>
                {order.phone && <div>{order.phone}</div>}
                {address && (
                  <div className="pt-2 text-muted-foreground">
                    {address.street}
                    {address.addressLine2 && `, ${address.addressLine2}`}
                    <br />
                    {address.postalCode} {address.city}, {address.country}
                  </div>
                )}
                {order.customerNote && (
                  <div className="mt-3 rounded-md bg-muted p-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      {t('buyer.note')}
                    </div>
                    {order.customerNote}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('payment.title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{t('payment.method')}</dt>
                  <dd>{tMethod(order.paymentMethod)}</dd>
                  <dt className="text-muted-foreground">{t('payment.total')}</dt>
                  <dd className="tabular-nums">{money(order.totalGross)}</dd>
                  <dt className="text-muted-foreground">{t('payment.paid')}</dt>
                  <dd className="tabular-nums">{money(order.amountPaid)}</dd>
                  {view.outstanding > 0 && open && (
                    <>
                      <dt className="text-muted-foreground">{t('payment.outstanding')}</dt>
                      <dd className="font-medium tabular-nums">{money(view.outstanding)}</dd>
                    </>
                  )}
                  {order.paymentReference && (
                    <>
                      <dt className="text-muted-foreground">{t('payment.reference')}</dt>
                      <dd className="font-mono">{order.paymentReference}</dd>
                    </>
                  )}
                  {order.paymentDueAt && (
                    <>
                      <dt className="text-muted-foreground">{t('payment.dueAt')}</dt>
                      <dd>{dateTime(order.paymentDueAt)}</dd>
                    </>
                  )}
                  {open && order.autoCancelAt && (
                    <>
                      <dt className="text-muted-foreground">{t('payment.autoCancelAt')}</dt>
                      <dd>
                        {order.keepReserved ? (
                          <Badge variant="secondary">{t('payment.keptReserved')}</Badge>
                        ) : (
                          dateTime(order.autoCancelAt)
                        )}
                      </dd>
                    </>
                  )}
                  {order.reminderCount > 0 && (
                    <>
                      <dt className="text-muted-foreground">{t('payment.reminders')}</dt>
                      <dd>
                        {order.reminderCount} ({dateTime(order.lastReminderAt)})
                      </dd>
                    </>
                  )}
                  {order.paidAt && (
                    <>
                      <dt className="text-muted-foreground">{t('payment.paidAt')}</dt>
                      <dd>{dateTime(order.paidAt)}</dd>
                    </>
                  )}
                  {order.cancellationReason && (
                    <>
                      <dt className="text-muted-foreground">{t('payment.reason')}</dt>
                      <dd>{order.cancellationReason}</dd>
                    </>
                  )}
                </dl>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t('items.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {view.events.map((event) => (
                <div key={event.eventId} className="space-y-2">
                  <div className="font-medium">
                    {event.title}{' '}
                    <span className="font-normal text-muted-foreground">
                      ·{' '}
                      {format.dateTime(new Date(event.startsAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: event.timeZone,
                      })}
                    </span>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('items.place')}</TableHead>
                        <TableHead>{t('items.category')}</TableHead>
                        <TableHead>{t('items.tariff')}</TableHead>
                        <TableHead>{t('items.status')}</TableHead>
                        <TableHead className="text-right">{t('items.price')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {event.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            {item.sectionLabel}
                            {item.kind === 'SEAT'
                              ? ` · ${t('items.rowSeat', { row: item.rowLabel ?? '–', seat: item.seatLabel ?? '–' })}`
                              : ` · ${t('items.standing')}`}
                          </TableCell>
                          <TableCell>{item.categoryName}</TableCell>
                          <TableCell>{item.ticketTypeName}</TableCell>
                          <TableCell>{t(`itemStatus.${item.status}`)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {item.discountAmount > 0 && (
                              <span className="mr-2 text-xs text-muted-foreground line-through">
                                {money(item.unitPriceGross)}
                              </span>
                            )}
                            {money(item.priceGross)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))}
              <div className="space-y-1 border-t pt-3 text-sm">
                {view.fees.map((fee) => (
                  <div key={fee.id} className="flex justify-between text-muted-foreground">
                    <span>
                      {fee.name}
                      {fee.quantity > 1 && ` (${fee.quantity}×)`}
                    </span>
                    <span className="tabular-nums">{money(fee.totalGross)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold">
                  <span>{t('items.total')}</span>
                  <span className="tabular-nums">{money(order.totalGross)}</span>
                </div>
                {view.taxes.map((tax) => (
                  <div
                    key={tax.rateBasisPoints}
                    className="flex justify-between text-xs text-muted-foreground"
                  >
                    <span>{t('items.tax', { rate: tax.rateBasisPoints / 100 })}</span>
                    <span className="tabular-nums">
                      {money(tax.net)} + {money(tax.tax)}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {view.tickets.length > 0 && (
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-3">
                <CardTitle>{t('tickets.title')}</CardTitle>
                {view.tickets.some((ticket) => ticket.status === 'VALID') && (
                  <Button asChild variant="outline" size="sm">
                    <a href={`/api/admin/orders/${order.id}/tickets`}>
                      <Download className="size-4" />
                      {t('tickets.downloadAll')}
                    </a>
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('tickets.code')}</TableHead>
                      <TableHead>{t('items.place')}</TableHead>
                      <TableHead>{t('tickets.attendee')}</TableHead>
                      <TableHead>{t('tickets.status')}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t('tickets.download')}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.tickets.map((ticket) => {
                      const item = view.events
                        .flatMap((event) => event.items)
                        .find((candidate) => candidate.id === ticket.orderItemId);
                      return (
                        <TableRow
                          key={ticket.id}
                          className={
                            ticket.status === 'VALID' ? undefined : 'text-muted-foreground'
                          }
                        >
                          <TableCell className="font-mono tracking-wider">
                            {formatTicketCode(ticket.ticketCode)}
                          </TableCell>
                          <TableCell>
                            {item
                              ? `${item.sectionLabel}${
                                  item.kind === 'SEAT'
                                    ? ` · ${t('items.rowSeat', { row: item.rowLabel ?? '–', seat: item.seatLabel ?? '–' })}`
                                    : ` · ${t('items.standing')}`
                                }`
                              : '–'}
                          </TableCell>
                          <TableCell>{ticket.attendeeName ?? '–'}</TableCell>
                          <TableCell>
                            {t(`tickets.statuses.${ticket.status}`)}
                            {ticket.checkInState !== 'NONE' &&
                              ` · ${t(`tickets.checkIn.${ticket.checkInState}`)}`}
                          </TableCell>
                          <TableCell className="text-right" data-slot="ticket-downloads">
                            {ticket.status === 'VALID' && (
                              <Button asChild variant="ghost" size="sm">
                                <a href={`/api/admin/orders/${order.id}/tickets/${ticket.id}`}>
                                  <Download className="size-4" />
                                  {t('tickets.pdf')}
                                </a>
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t('payments.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              {view.payments.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('payments.empty')}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('payments.date')}</TableHead>
                      <TableHead>{t('payments.method')}</TableHead>
                      <TableHead>{t('payments.status')}</TableHead>
                      <TableHead>{t('payments.reference')}</TableHead>
                      <TableHead className="text-right">{t('payments.amount')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="whitespace-nowrap">
                          {dateTime(p.capturedAt ?? p.createdAt)}
                        </TableCell>
                        <TableCell>{tMethod(p.method)}</TableCell>
                        <TableCell>
                          {tPayment(p.status)}
                          {p.failureCode && (
                            <div className="text-xs text-destructive">{p.failureCode}</div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {p.providerCaptureId ??
                            p.providerOrderId ??
                            (p.bankTransactionId ? t('payments.bank') : '–')}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(p.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {view.invoices.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('documents.title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {view.invoices.map((invoice) => (
                    <li key={invoice.id}>
                      <a
                        href={`/api/admin/invoices/${invoice.id}`}
                        className="inline-flex items-center gap-2 hover:underline"
                      >
                        <Download className="size-4" /> {invoice.invoiceNumber} ·{' '}
                        {dateTime(invoice.issuedAt)}
                      </a>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t('history.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 text-sm">
                {view.history.map((h) => (
                  <li key={h.id} className="flex gap-3">
                    <span className="w-36 shrink-0 text-xs text-muted-foreground">
                      {dateTime(h.createdAt)}
                    </span>
                    <div>
                      <div>
                        {t.has(`history.types.${h.type}` as never)
                          ? t(`history.types.${h.type}` as never)
                          : h.type}
                        {h.toStatus && ` → ${tStatus(h.toStatus)}`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {h.actorName ?? t(`history.actors.${h.actorType}`)}
                        {h.data && typeof h.data === 'object' && 'reason' in h.data && h.data.reason
                          ? ` · ${String(h.data.reason)}`
                          : ''}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-6">
          <OrderAdminActions
            orderId={order.id}
            status={order.status}
            keepReserved={order.keepReserved}
            keepReservedReason={order.keepReservedReason}
            outstanding={open || order.status === 'PAID' ? Math.max(view.outstanding, 0) : 0}
            currency={order.currency}
            internalNote={order.internalNote}
            canRecordPayment={hasRole(session, ['FINANCE'])}
            canResend={resendableEmail(order.status, order.paymentMethod) !== null}
          />
        </aside>
      </div>
    </>
  );
}
