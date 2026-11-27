import {
  buildOrderViewModel,
  getOrderAdminView,
  holderTicketUrls,
  listTicketChanges,
  getSetting,
  getTariffChangeOptions,
  listOrderAdjustments,
  getOrderCredit,
  listOrderRefundBatches,
  orderUrl,
  resendableEmail,
  listOrderEmails,
  type OrderItemLine,
} from '@tix/core';
import { orders } from '@tix/db';
import { formatTicketCode } from '@tix/shared';
import { and, count, eq } from 'drizzle-orm';
import { Ban, CreditCard, Download, Trash2 } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { OrderEmailsCard } from '@/components/admin/communication/order-communication';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { ReverseAllocationButton } from '@/components/admin/banking/reverse-allocation';
import { DetailLayout, DetailSection } from '@/components/admin/detail-layout';
import { EmptyState } from '@/components/admin/empty-state';
import {
  InternalNoteForm,
  KeepReservedSwitch,
  OrderHeaderActions,
  type PaidCancelProps,
} from '@/components/admin/order-actions';
import { OpenAdjustmentCard, type TariffChangeProps } from '@/components/admin/order-adjustment';
import {
  ResendHolderMailButton,
  TicketSelfServiceActions,
} from '@/components/shop/ticket-self-service';
import { OrderStatusBadge } from '@/components/admin/order-badges';
import { OrderInvoiceList } from '@/components/orders/order-invoice-list';
import { OrderItemsCard } from '@/components/orders/order-items-card';
import { OrderTimeline } from '@/components/admin/order-timeline';
import { EntityAuditCard } from '@/components/admin/entity-audit-card';
import { OverpaymentCard, RefundBatchList } from '@/components/admin/refund-batches';
import { AdminPageHeader } from '@/components/admin/page-header';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { cancelHideTestOrderAction, deleteTestOrderAction } from '@/server/admin/test-orders';

export async function generateMetadata() {
  const t = await getTranslations('orders.admin');
  return { title: t('detailTitle') };
}

/** Inactive activity tabs stay in the DOM (hidden), so their lists need no extra request. */
const TAB_PANEL = 'mt-2 data-[state=inactive]:hidden';

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
  const [view, refundBatches, checkout, adjustments, orderCredit, ticketChanges] =
    await Promise.all([
      getOrderAdminView(core, id),
      listOrderRefundBatches(core, id),
      getSetting(core, 'checkout'),
      listOrderAdjustments(core, id),
      getOrderCredit(core.db, id),
      listTicketChanges(core, id),
    ]);
  if (!view) notFound();
  const { order } = view;
  // Real money was received on a test order: it cannot be deleted any more, only cancelled & hidden.
  const testMoneyCaptured =
    order.isTest &&
    (view.payments.some(
      (p) => p.capturedAt !== null && p.amount > 0 && p.method !== 'COMPLIMENTARY',
    ) ||
      view.allocations.length > 0);
  const [t, tChannel, tMethod, tPayment, tEmails, tAudit, format, customerOrders] =
    await Promise.all([
      getTranslations('orders.admin'),
      getTranslations('orders.channel'),
      getTranslations('orders.method'),
      getTranslations('orders.paymentStatus'),
      getTranslations('communication.orderEmails'),
      getTranslations('audit.entityCard'),
      getFormatter(),
      order.customerId
        ? core.db
            .select({ n: count() })
            .from(orders)
            .where(and(eq(orders.customerId, order.customerId), eq(orders.isTest, false)))
            .then((rows) => rows[0]?.n ?? 0)
        : Promise.resolve(0),
    ]);
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: order.currency });
  const dateTime = (d: Date | string | null) =>
    d ? format.dateTime(new Date(d), { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  const model = buildOrderViewModel(view, { audience: 'admin' });
  const open = order.status === 'PENDING' || order.status === 'AWAITING_PAYMENT';
  const address = order.billingAddress;
  const canRefund = hasRole(session, ['FINANCE']);
  // Cancelling paid orders and recording payments: finance and event managers (docs/ADMIN-SECURITY.md).
  const canCancelPaid = hasRole(session, ['FINANCE', 'EVENT_MANAGER']);
  const canManage = hasRole(session, ['FINANCE', 'EVENT_MANAGER']);
  const canOpenEvents = hasRole(session, ['EVENT_MANAGER']);
  const orderEmails = await listOrderEmails(core, id);
  const tEmailKeys = await getTranslations('emailTemplates.keys');
  const emailLabels = Object.fromEntries(
    [...new Set(orderEmails.flatMap((m) => (m.templateKey ? [m.templateKey] : [])))].map((key) => [
      key,
      tEmailKeys.has(`${key}.name` as never) ? tEmailKeys(`${key}.name` as never) : key,
    ]),
  );
  // Spots of admission-only events read "Admission", standing areas of seated events "Standing".
  const admissionItemIds = new Set(
    view.events.filter((e) => e.admission).flatMap((e) => e.items.map((i) => i.id)),
  );
  const placeLabel = (
    item: { id: string } & Pick<OrderItemLine, 'kind' | 'sectionLabel' | 'rowLabel' | 'seatLabel'>,
  ) =>
    `${item.sectionLabel}${
      item.kind === 'SEAT'
        ? ` · ${t('items.rowSeat', { row: item.rowLabel ?? '–', seat: item.seatLabel ?? '–' })}`
        : ` · ${t(admissionItemIds.has(item.id) ? 'items.admission' : 'items.standing')}`
    }`;
  const openAdjustment =
    adjustments.find((a) => a.status === 'PROPOSED' || a.status === 'CONFIRMED') ?? null;
  // Same as the core: what an open tariff change reserves cannot be refunded.
  const refundableCredit = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.status)
    ? orderCredit.credit - (openAdjustment?.creditApplied ?? 0)
    : 0;
  const proposable = order.status === 'PAID' && order.paymentMethod !== 'COMPLIMENTARY';
  const tariffOptions =
    proposable && !openAdjustment
      ? new Map((await getTariffChangeOptions(core, id)).map((o) => [o.orderItemId, o.options]))
      : new Map<string, { id: string; name: string; priceGross: number }[]>();
  const confirmedItems = view.events.flatMap((event) =>
    event.items.filter((item) => item.status === 'CONFIRMED').map((item) => ({ event, item })),
  );
  const paidCancel: PaidCancelProps | null =
    canCancelPaid && (order.status === 'PAID' || order.status === 'PARTIALLY_REFUNDED')
      ? {
          version: order.version,
          currency: order.currency,
          refundFeesDefault: checkout.refundFeesByDefault,
          items: confirmedItems.map(({ event, item }) => ({
            id: item.id,
            label: `${event.title} · ${placeLabel(item)}`,
            detail: `${item.categoryName} · ${item.ticketTypeName}`,
            price: item.priceGross,
          })),
        }
      : null;
  // Tariff change: PAID orders without an open additional payment, FINANCE / EVENT_MANAGER.
  const tariffChange: TariffChangeProps | null =
    proposable && canManage && !openAdjustment
      ? {
          orderId: order.id,
          version: order.version,
          currency: order.currency,
          hasEmail: Boolean(order.email),
          credit: orderCredit.credit,
          canUseCredit: hasRole(session, ['FINANCE']),
          items: confirmedItems.map(({ event, item }) => ({
            id: item.id,
            label: `${event.title} · ${placeLabel(item)}`,
            detail: `${item.categoryName} · ${item.ticketTypeName} · ${money(item.priceGross)}`,
            paid: item.priceGross,
            options: tariffOptions.get(item.id) ?? [],
          })),
        }
      : null;

  const dl = 'grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm';
  const dt = 'text-muted-foreground';

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[{ label: t('title'), href: '/admin/orders' }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t('detailHeading', { number: order.orderNumber })}{' '}
            <OrderStatusBadge status={order.status} />
            {order.isTest && (
              <Badge variant="outline" className="border-warning-border text-warning">
                {t('testBadge')}
              </Badge>
            )}
            {order.isTest && order.testHiddenAt && (
              <Badge variant="outline">{t('testHidden')}</Badge>
            )}
          </span>
        }
        description={`${dateTime(order.createdAt)} · ${tMethod(order.paymentMethod)} · ${money(order.totalGross)}`}
        actions={
          <>
            {order.isTest && hasRole(session, ['SUPER_ADMIN']) && !testMoneyCaptured && (
              <ConfirmAction
                action={deleteTestOrderAction.bind(null, order.id)}
                title={t('testDelete.title')}
                description={t('testDelete.description')}
                confirmLabel={t('testDelete.confirm')}
              >
                <Trash2 /> {t('testDelete.button')}
              </ConfirmAction>
            )}
            {order.isTest &&
              hasRole(session, ['SUPER_ADMIN']) &&
              testMoneyCaptured &&
              !order.testHiddenAt && (
                <ConfirmAction
                  action={cancelHideTestOrderAction.bind(null, order.id)}
                  title={t('testCancelHide.title')}
                  description={t('testCancelHide.description')}
                  confirmLabel={t('testCancelHide.confirm')}
                >
                  <Ban /> {t('testCancelHide.button')}
                </ConfirmAction>
              )}
            <OrderHeaderActions
              orderId={order.id}
              status={order.status}
              version={order.version}
              outstanding={open || order.status === 'PAID' ? Math.max(view.outstanding, 0) : 0}
              currency={order.currency}
              email={order.email}
              customerViewHref={orderUrl(core, order)}
              canRecordPayment={canCancelPaid}
              canResend={
                Boolean(order.email) && resendableEmail(order.status, order.paymentMethod) !== null
              }
              paidCancel={paidCancel}
              tariffChange={tariffChange}
              hasMovableSeats={view.events.some(
                (e) =>
                  !e.admission &&
                  e.items.some(
                    (i) =>
                      i.kind === 'SEAT' && (i.status === 'PENDING' || i.status === 'CONFIRMED'),
                  ),
              )}
            />
          </>
        }
      />
      <DetailLayout
        aside={
          <>
            <DetailSection
              title={t('actions.note.title')}
              description={t('actions.note.description')}
            >
              <InternalNoteForm orderId={order.id} note={order.internalNote} />
            </DetailSection>
            <DetailSection title={t('aside.customer')} data-testid="order-customer">
              <div className="space-y-1 text-sm">
                <div className="font-medium">
                  {order.firstName} {order.lastName}
                </div>
                {order.customerId ? (
                  <>
                    <div className="text-muted-foreground">
                      {t('aside.customerOrders', { count: customerOrders })}
                    </div>
                    <Link
                      href={`/admin/customers/${order.customerId}`}
                      className="inline-block pt-1 font-medium underline-offset-4 hover:underline"
                    >
                      {t('aside.openCustomer')}
                    </Link>
                  </>
                ) : (
                  <div className="text-muted-foreground">{t('aside.noCustomer')}</div>
                )}
              </div>
            </DetailSection>
            <DetailSection title={t('aside.events')}>
              <ul className="space-y-2 text-sm">
                {view.events.map((event) => (
                  <li key={event.eventId}>
                    {canOpenEvents ? (
                      <Link
                        href={`/admin/events/${event.eventId}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {event.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{event.title}</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {format.dateTime(new Date(event.startsAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: event.timeZone,
                      })}
                      {event.venueName && ` · ${event.venueName}`}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          </>
        }
      >
        <div className="grid gap-6 md:grid-cols-2">
          <DetailSection title={t('buyer.title')}>
            <div className="space-y-1 text-sm">
              <div className="font-medium">
                {order.firstName} {order.lastName}
              </div>
              {order.company && <div>{order.company}</div>}
              {order.email && (
                <div>
                  <a href={`mailto:${order.email}`} className="hover:underline">
                    {order.email}
                  </a>
                </div>
              )}
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
                  <div className="text-xs font-medium text-muted-foreground">{t('buyer.note')}</div>
                  {order.customerNote}
                </div>
              )}
            </div>
          </DetailSection>
          <DetailSection title={t('payment.title')} contentClassName="space-y-4">
            <dl className={dl}>
              <dt className={dt}>{t('payment.method')}</dt>
              <dd>{tMethod(order.paymentMethod)}</dd>
              <dt className={dt}>{tChannel('title')}</dt>
              <dd>
                {tChannel(order.channel)}
                {view.soldByName && (
                  <span className="text-muted-foreground">
                    {' '}
                    · {tChannel('soldBy')} {view.soldByName}
                  </span>
                )}
              </dd>
              {view.discounts.length > 0 && (
                <>
                  <dt className={dt}>{t('payment.discount')}</dt>
                  <dd className="tabular-nums">
                    {view.discounts.map((d) => d.code).join(', ')} · −
                    {money(view.discounts.reduce((sum, d) => sum + d.amount, 0))}
                  </dd>
                </>
              )}
              <dt className={dt}>{t('payment.total')}</dt>
              <dd className="tabular-nums">{money(order.totalGross)}</dd>
              <dt className={dt}>{t('payment.paid')}</dt>
              <dd className="tabular-nums">{money(order.amountPaid)}</dd>
              {order.amountRefunded > 0 && (
                <>
                  <dt className={dt}>{t('payment.refunded')}</dt>
                  <dd className="tabular-nums">−{money(order.amountRefunded)}</dd>
                </>
              )}
              {view.outstanding > 0 && open && (
                <>
                  <dt className={dt}>{t('payment.outstanding')}</dt>
                  <dd className="font-medium tabular-nums">{money(view.outstanding)}</dd>
                </>
              )}
              {order.paymentReference && (
                <>
                  <dt className={dt}>{t('payment.reference')}</dt>
                  <dd className="font-mono">{order.paymentReference}</dd>
                </>
              )}
              {order.paymentDueAt && (
                <>
                  <dt className={dt}>{t('payment.dueAt')}</dt>
                  <dd>{dateTime(order.paymentDueAt)}</dd>
                </>
              )}
              {open && order.autoCancelAt && (
                <>
                  <dt className={dt}>{t('payment.autoCancelAt')}</dt>
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
                  <dt className={dt}>{t('payment.reminders')}</dt>
                  <dd>
                    {order.reminderCount} ({dateTime(order.lastReminderAt)})
                  </dd>
                </>
              )}
              {order.paidAt && (
                <>
                  <dt className={dt}>{t('payment.paidAt')}</dt>
                  <dd>{dateTime(order.paidAt)}</dd>
                </>
              )}
              {order.cancellationReason && (
                <>
                  <dt className={dt}>{t('payment.reason')}</dt>
                  <dd>{order.cancellationReason}</dd>
                </>
              )}
            </dl>
            {order.status === 'AWAITING_PAYMENT' && (
              <KeepReservedSwitch
                orderId={order.id}
                keepReserved={order.keepReserved}
                keepReservedReason={order.keepReservedReason}
              />
            )}
          </DetailSection>
        </div>

        {openAdjustment && (
          <OpenAdjustmentCard
            currency={order.currency}
            canManage={canManage}
            canRecordPayment={canCancelPaid}
            credit={orderCredit.credit}
            open={{
              id: openAdjustment.id,
              status: openAdjustment.status as 'PROPOSED' | 'CONFIRMED',
              amount: openAdjustment.amount,
              creditApplied: openAdjustment.creditApplied,
              reference: openAdjustment.paymentReference,
              reason: openAdjustment.reason,
              createdAt: openAdjustment.createdAt.toISOString(),
              confirmedAt: openAdjustment.confirmedAt?.toISOString() ?? null,
              reminderSentAt: openAdjustment.reminderSentAt?.toISOString() ?? null,
              items: openAdjustment.items.map((i) => ({
                from: i.fromName,
                to: i.toName,
                fromPrice: i.fromPriceGross,
                toPrice: i.toPriceGross,
              })),
            }}
          />
        )}

        <OrderItemsCard
          audience="admin"
          events={model.events}
          totals={model.totals}
          money={money}
          labels={{
            title: t('items.title'),
            total: t('items.total'),
            place: placeLabel,
            eventDate: (event) =>
              format.dateTime(new Date(event.startsAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: event.timeZone,
              }),
            tax: (tax) => t('items.tax', { rate: tax.rateBasisPoints / 100 }),
            columns: {
              place: t('items.place'),
              category: t('items.category'),
              tariff: t('items.tariff'),
              status: t('items.status'),
              price: t('items.price'),
            },
            itemStatus: (item) => t(`itemStatus.${item.status}`),
          }}
        />

        {view.tickets.length > 0 && (
          <DetailSection
            title={t('tickets.title')}
            actions={
              view.tickets.some((ticket) => ticket.status === 'VALID') && (
                <Button asChild variant="outline" size="sm">
                  <a href={`/api/admin/orders/${order.id}/tickets`}>
                    <Download className="size-4" />
                    {t('tickets.downloadAll')}
                  </a>
                </Button>
              )
            }
          >
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
                      className={ticket.status === 'VALID' ? undefined : 'text-muted-foreground'}
                    >
                      <TableCell className="font-mono tracking-wider">
                        {formatTicketCode(ticket.ticketCode)}
                      </TableCell>
                      <TableCell>{item ? placeLabel(item) : '–'}</TableCell>
                      <TableCell>
                        {ticket.attendeeName ?? '–'}
                        {ticket.holderEmail && (
                          <span className="block text-xs text-muted-foreground">
                            {ticket.holderEmail}
                            {ticket.status === 'VALID' && (
                              <>
                                {' · '}
                                <a
                                  className="underline"
                                  data-slot="holder-ticket-link"
                                  href={holderTicketUrls(core, ticket, order.locale)?.page ?? '#'}
                                >
                                  {t('ticketChanges.recipientPage')}
                                </a>
                              </>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {t(`tickets.statuses.${ticket.status}`)}
                        {ticket.checkInState !== 'NONE' &&
                          ` · ${t(`tickets.checkIn.${ticket.checkInState}`)}`}
                      </TableCell>
                      <TableCell className="text-right" data-slot="ticket-downloads">
                        {ticket.status === 'VALID' &&
                          ticket.checkInState === 'NONE' &&
                          (order.status === 'PAID' || order.status === 'PARTIALLY_REFUNDED') && (
                            <TicketSelfServiceActions
                              orderId={order.id}
                              token={null}
                              ticketId={ticket.id}
                              ticketCode={formatTicketCode(ticket.ticketCode)}
                              attendeeName={ticket.attendeeName}
                              canChangeName
                              canTransfer
                              admin
                              apiBase={`/api/admin/orders/${order.id}/tickets/${ticket.id}`}
                            />
                          )}
                        {ticket.status === 'VALID' && ticket.holderEmail && (
                          <ResendHolderMailButton
                            apiBase={`/api/admin/orders/${order.id}/tickets/${ticket.id}`}
                          />
                        )}
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
          </DetailSection>
        )}

        {ticketChanges.length > 0 && (
          <DetailSection title={t('ticketChanges.title')} data-testid="ticket-changes">
            <ul className="divide-y text-sm">
              {ticketChanges.map((c) => (
                <li key={c.id} className="py-2">
                  <div className="font-medium">
                    {c.kind === 'TRANSFER'
                      ? t('ticketChanges.transfer', {
                          name: c.newName ?? '–',
                          email: c.recipientEmail ?? '–',
                        })
                      : t('ticketChanges.name', {
                          from: c.oldName ?? '–',
                          to: c.newName ?? '–',
                        })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {format.dateTime(c.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                    {' · '}
                    {t(c.actor === 'ADMIN' ? 'ticketChanges.byAdmin' : 'ticketChanges.byCustomer')}
                    {c.message ? ` · "${c.message}"` : ''}
                  </div>
                </li>
              ))}
            </ul>
          </DetailSection>
        )}

        <DetailSection title={t('payments.title')} data-testid="order-payments">
          {view.payments.length === 0 ? (
            <EmptyState size="sm" icon={CreditCard} title={t('payments.empty')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('payments.date')}</TableHead>
                  <TableHead>{t('payments.method')}</TableHead>
                  <TableHead>{t('payments.status')}</TableHead>
                  <TableHead>{t('payments.reference')}</TableHead>
                  <TableHead className="text-right">{t('payments.amount')}</TableHead>
                  {canRefund && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.payments.map((p) => {
                  const allocation = view.allocations.find((a) => a.paymentId === p.id);
                  return (
                    <TableRow key={p.id} className={p.status === 'CANCELLED' ? 'opacity-60' : ''}>
                      <TableCell className="whitespace-nowrap">
                        {dateTime(p.capturedAt ?? p.createdAt)}
                      </TableCell>
                      <TableCell>{tMethod(p.method)}</TableCell>
                      <TableCell>
                        {tPayment(p.status)}
                        {allocation?.reversedAt ? (
                          <div className="text-xs text-muted-foreground">
                            {t('payments.reversed', {
                              who: allocation.reversedByName ?? '–',
                              when: dateTime(allocation.reversedAt),
                            })}
                            {allocation.reversalReason ? ` – ${allocation.reversalReason}` : ''}
                          </div>
                        ) : (
                          p.failureCode && (
                            <div className="text-xs text-destructive">{p.failureCode}</div>
                          )
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {p.providerCaptureId ??
                          p.providerOrderId ??
                          (p.bankTransactionId ? t('payments.bank') : '–')}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(p.amount)}</TableCell>
                      {canRefund && (
                        <TableCell className="text-right">
                          {allocation && !allocation.reversedAt && p.status === 'CAPTURED' && (
                            <ReverseAllocationButton
                              allocationId={allocation.id}
                              orderNumber={order.orderNumber}
                            />
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </DetailSection>

        {refundableCredit > 0 && (
          <OverpaymentCard
            orderId={order.id}
            amount={refundableCredit}
            currency={order.currency}
            reserved={openAdjustment?.creditApplied ?? 0}
            canRefund={canRefund}
          />
        )}

        {refundBatches.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t('refunds.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <RefundBatchList batches={refundBatches} canAct={canRefund} />
            </CardContent>
          </Card>
        )}

        <OrderInvoiceList
          title={t('documents.title')}
          invoices={model.invoices}
          label={(invoice) => (
            <>
              {invoice.number} ·{' '}
              {invoice.kind === 'correction'
                ? t('documents.correction', { invoice: invoice.correctsNumber ?? '' })
                : t(
                    invoice.kind === 'creditNote' ? 'documents.creditNote' : 'documents.invoice',
                  )}{' '}
              · {dateTime(invoice.issuedAt)}
            </>
          )}
        />

        <DetailSection title={t('activity.title')} data-testid="order-activity">
          <Tabs defaultValue="history">
            <TabsList>
              <TabsTrigger value="history">{t('history.title')}</TabsTrigger>
              <TabsTrigger value="emails">
                {tEmails('title')}
                {orderEmails.length > 0 && (
                  <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                    {orderEmails.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="changes">{tAudit('title')}</TabsTrigger>
            </TabsList>
            <TabsContent value="history" forceMount className={TAB_PANEL}>
              <OrderTimeline view={view} />
            </TabsContent>
            <TabsContent value="emails" forceMount className={TAB_PANEL}>
              <OrderEmailsCard
                bare
                items={orderEmails.map((m) => ({
                  ...m,
                  createdAt: m.createdAt.toISOString(),
                  sentAt: m.sentAt?.toISOString() ?? null,
                }))}
                templateLabels={emailLabels}
                canRetry={canManage}
              />
            </TabsContent>
            <TabsContent value="changes" forceMount className={TAB_PANEL}>
              <EntityAuditCard
                bare
                entityType="order"
                entityId={order.id}
                showFullLogLink={hasRole(session, ['SUPER_ADMIN'])}
              />
            </TabsContent>
          </Tabs>
        </DetailSection>
      </DetailLayout>
    </>
  );
}
