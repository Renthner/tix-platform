import {
  findOrderIdByNumber,
  getSetting,
  getOrderView,
  loadOrderCalendarEvents,
  orderCalendarPath,
  getTicketSelfServiceStates,
  walletAvailability,
  walletTicketPath,
  buildOrderViewModel,
  type BankDetailsModel,
  type OrderItemLine,
  type OrderView,
} from '@tix/core';
import { EmailText } from '@/components/email-text';
import { formatTicketCode } from '@tix/shared';
import {
  CalendarPlus,
  CheckCircle2,
  Clock,
  Download,
  Info,
  MapPin,
  Undo2,
  XCircle,
} from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { BankTransferDetails } from '@/components/orders/bank-transfer-details';
import { OrderInvoiceList } from '@/components/orders/order-invoice-list';
import { OrderItemsCard } from '@/components/orders/order-items-card';
import { OrderPaymentActions } from '@/components/shop/order-actions';
import {
  AdjustmentConfirmButton,
  AdjustmentPayPalButton,
} from '@/components/shop/order-adjustment';
import { TicketSelfServiceActions } from '@/components/shop/ticket-self-service';
import { OrderAutoRefresh } from '@/components/shop/order-auto-refresh';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { canAccessOrder } from '@/server/order-access';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('checkout.order');
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

const PAYPAL_NOTICES = [
  'paid',
  'pending',
  'cancelled',
  'failed',
  'expired',
  'unavailable',
  'notavailable',
] as const;
type PayPalNotice = (typeof PAYPAL_NOTICES)[number];

const PREPARING_WINDOW_MS = 10 * 60 * 1000;

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; number: string }>;
  searchParams: Promise<{ t?: string; paypal?: string; wallet?: string }>;
}) {
  const locale = await resolveLocale(params);
  const { number } = await params;
  const { t: token, paypal, wallet: walletParam } = await searchParams;
  const core = getCore();
  const orderId = await findOrderIdByNumber(core, decodeURIComponent(number));
  // Unknown order and missing access look the same (no enumeration of order numbers).
  if (!orderId || !(await canAccessOrder(orderId, token))) notFound();
  const view = (await getOrderView(core, orderId))!;
  const { order } = view;
  // Test orders (super-admin test purchases) get no wallet passes.
  const wallet = order.isTest ? { apple: false, google: false } : await walletAvailability(core);
  const [t, format] = await Promise.all([getTranslations('checkout.order'), getFormatter()]);
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: order.currency });
  const notice = (PAYPAL_NOTICES as readonly string[]).includes(paypal ?? '')
    ? (paypal as PayPalNotice)
    : null;
  const walletFailed = walletParam === 'unavailable';
  const issuedTickets = view.tickets.filter((ticket) => ticket.status === 'VALID');
  const selfService = new Map(
    (await getTicketSelfServiceStates(core, orderId)).map((s) => [s.ticketId, s]),
  );
  const tokenQuery = token ? `?t=${encodeURIComponent(token)}` : '';
  const model = buildOrderViewModel(view, { audience: 'shop', tokenQuery });
  const placeText = (
    item: Pick<OrderItemLine, 'kind' | 'sectionLabel' | 'rowLabel' | 'seatLabel'>,
  ) =>
    item.kind === 'SEAT'
      ? [
          item.sectionLabel,
          item.rowLabel ? t('items.row', { label: item.rowLabel }) : null,
          t('items.seat', { label: item.seatLabel ?? '' }),
        ]
          .filter(Boolean)
          .join(' · ')
      : `${item.sectionLabel} · ${t('items.standing')}`;
  const placeByItem = new Map(
    model.events.flatMap((event) => event.items.map((item) => [item.id, placeText(item)])),
  );
  const invoicing = await getSetting(core, 'invoicing');
  const expectsTickets = view.events.some((event) =>
    event.items.some((item) => item.status === 'CONFIRMED'),
  );
  const recentlyPaid = !!order.paidAt && Date.now() - order.paidAt.getTime() < PREPARING_WINDOW_MS;
  // Only wait for what will actually be produced, and only shortly after payment.
  const preparing =
    (order.status === 'PAID' || order.status === 'PARTIALLY_REFUNDED') &&
    recentlyPaid &&
    ((expectsTickets && issuedTickets.length === 0) ||
      (invoicing.issueInvoices && !order.isTest && view.invoices.length === 0));
  // Upcoming events of the order: calendar file, Google Calendar and directions.
  const calendarEvents = (await loadOrderCalendarEvents(core, order.id, { locale })).filter(
    (event) => event.endsAt.getTime() > Date.now(),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('title', { number: order.orderNumber })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('placedAt', {
              date: format.dateTime(order.createdAt, { dateStyle: 'long', timeStyle: 'short' }),
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {order.isTest && (
            <Badge variant="outline" className="border-warning-border text-sm text-warning">
              {t('testBadge')}
            </Badge>
          )}
          <Badge variant={order.status === 'PAID' ? 'default' : 'secondary'} className="text-sm">
            {t(`status.${order.status}`)}
          </Badge>
        </div>
      </div>

      {order.isTest && (
        <Alert className="border-warning-border bg-warning-soft text-warning">
          <Info className="size-4" />
          <AlertDescription>{t('testNotice')}</AlertDescription>
        </Alert>
      )}

      {notice && notice !== 'paid' && (
        <Alert variant={notice === 'pending' ? 'default' : 'destructive'}>
          <Info className="size-4" />
          <AlertDescription>
            {view.adjustment || order.status === 'PAID'
              ? t(`adjustment.paypalNotice.${notice}`)
              : t(`paypalNotice.${notice}`)}
          </AlertDescription>
        </Alert>
      )}

      {walletFailed && (
        <Alert variant="destructive">
          <Info className="size-4" />
          <AlertDescription>{t('walletNotice.unavailable')}</AlertDescription>
        </Alert>
      )}

      <StatusCard
        view={view}
        bank={model.bank}
        money={money}
        token={token ?? null}
        format={format}
        t={t}
      />

      {view.adjustment && (
        <AdjustmentCard
          orderId={order.id}
          adjustment={view.adjustment}
          placeByItem={placeByItem}
          money={money}
          token={token ?? null}
          t={t}
        />
      )}

      {preparing && <OrderAutoRefresh />}

      <OrderItemsCard
        audience="shop"
        events={model.events}
        totals={model.totals}
        money={money}
        labels={{
          title: t('items.title'),
          total: t('items.total'),
          place: placeText,
          eventDate: (event) =>
            format.dateTime(new Date(event.startsAt), {
              dateStyle: 'full',
              timeStyle: 'short',
              timeZone: event.timeZone,
            }),
          tax: (tax) => t('items.vat', { rate: tax.rateBasisPoints / 100 }),
          discount: (codes) => t('items.discount', { codes }),
          refundedItem: t('items.refundedItem'),
          paid: t('items.paid'),
          refunded: t('items.refunded'),
        }}
      />

      {issuedTickets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('tickets.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('tickets.intro')}</p>
            <div
              className="pt-1"
              data-slot="ticket-downloads-all"
              hidden={!issuedTickets.some((x) => !x.holderEmail)}
            >
              <Button asChild variant="outline" size="sm">
                <a href={`/api/orders/${order.id}/tickets${tokenQuery}`}>
                  <Download className="size-4" />
                  {t('tickets.downloadAll')}
                </a>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {issuedTickets.map((ticket) => (
                <li key={ticket.id} className="flex flex-wrap justify-between gap-3 py-2">
                  <div>
                    <div className="font-mono font-medium tracking-wider">
                      {formatTicketCode(ticket.ticketCode)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {placeByItem.get(ticket.orderItemId) ?? ''}
                      {ticket.attendeeName ? ` · ${ticket.attendeeName}` : ''}
                    </div>
                    {ticket.holderEmail && (
                      <div className="text-xs text-muted-foreground" data-slot="ticket-transferred">
                        {t('selfService.heldBy', { email: ticket.holderEmail })}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2" data-slot="ticket-downloads">
                    {selfService.get(ticket.id) && (
                      <TicketSelfServiceActions
                        orderId={order.id}
                        token={token ?? null}
                        ticketId={ticket.id}
                        ticketCode={formatTicketCode(ticket.ticketCode)}
                        attendeeName={ticket.attendeeName}
                        canChangeName={selfService.get(ticket.id)!.nameBlock === null}
                        canTransfer={selfService.get(ticket.id)!.transferBlock === null}
                      />
                    )}
                    {!ticket.holderEmail && (
                      <>
                        <Button asChild variant="ghost" size="sm">
                          <a
                            href={`/api/orders/${order.id}/tickets/${ticket.id}${tokenQuery}`}
                            aria-label={t('tickets.downloadOneLabel', {
                              code: formatTicketCode(ticket.ticketCode),
                            })}
                          >
                            <Download className="size-4" />
                            {t('tickets.downloadOne')}
                          </a>
                        </Button>
                        {wallet.apple && (
                          <Button asChild variant="ghost" size="sm">
                            <a href={walletTicketPath(order.id, ticket.id, 'pkpass', token)}>
                              {t('tickets.addApple')}
                            </a>
                          </Button>
                        )}
                        {wallet.google && (
                          <Button asChild variant="ghost" size="sm">
                            <a href={walletTicketPath(order.id, ticket.id, 'google', token)}>
                              {t('tickets.addGoogle')}
                            </a>
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {calendarEvents.length > 0 && (
        <Card data-slot="order-calendar">
          <CardHeader>
            <CardTitle>{t('calendar.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('calendar.intro')}</p>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {calendarEvents.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <div className="font-medium">{event.title}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a href={orderCalendarPath(core, order.id, event.id)}>
                        <CalendarPlus className="size-4" />
                        {t('calendar.ics')}
                      </a>
                    </Button>
                    <Button asChild variant="outline" size="sm">
                      <a href={event.googleUrl} target="_blank" rel="noopener noreferrer">
                        <CalendarPlus className="size-4" />
                        {t('calendar.google')}
                      </a>
                    </Button>
                    <Button asChild variant="outline" size="sm">
                      <a href={event.directionsUrl} target="_blank" rel="noopener noreferrer">
                        <MapPin className="size-4" />
                        {t('calendar.directions')}
                      </a>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <OrderInvoiceList
        title={t('documents.title')}
        invoices={model.invoices}
        label={(invoice) =>
          invoice.kind === 'correction'
            ? t('documents.correction', {
                number: invoice.number,
                invoice: invoice.correctsNumber ?? '',
              })
            : t(invoice.kind === 'creditNote' ? 'documents.creditNote' : 'documents.invoice', {
                number: invoice.number,
              })
        }
      />

      <EmailText
        as="p"
        className="text-xs text-muted-foreground"
        text={t('contact', { email: order.email ?? '' })}
      />
    </div>
  );
}

function StatusCard({
  view,
  bank,
  money,
  token,
  format,
  t,
}: {
  view: OrderView;
  bank: BankDetailsModel | null;
  money: (cents: number) => string;
  token: string | null;
  format: Awaited<ReturnType<typeof getFormatter>>;
  t: Awaited<ReturnType<typeof getTranslations<'checkout.order'>>>;
}) {
  const { order } = view;
  if (order.status === 'PAID') {
    return (
      <Alert>
        <CheckCircle2 className="size-4" />
        <AlertTitle>{t('paid.title')}</AlertTitle>
        <AlertDescription>
          <EmailText text={t('paid.text', { email: order.email ?? '' })} />
        </AlertDescription>
      </Alert>
    );
  }
  if (order.status === 'REFUNDED' || order.status === 'PARTIALLY_REFUNDED') {
    const key = order.status === 'REFUNDED' ? 'refunded' : 'partiallyRefunded';
    return (
      <Alert variant={order.status === 'REFUNDED' ? 'destructive' : 'default'}>
        <Undo2 className="size-4" />
        <AlertTitle>{t(`${key}.title`)}</AlertTitle>
        <AlertDescription>
          {t(`${key}.text`)}
          {order.amountRefunded > 0 &&
            ` ${t('refundedAmount', { amount: money(order.amountRefunded) })}`}
        </AlertDescription>
      </Alert>
    );
  }
  if (order.status === 'CANCELLED' || order.status === 'EXPIRED') {
    return (
      <Alert variant="destructive">
        <XCircle className="size-4" />
        <AlertTitle>{t(`closed.${order.status}`)}</AlertTitle>
        <AlertDescription>{t('closed.text')}</AlertDescription>
      </Alert>
    );
  }
  if (order.status === 'AWAITING_PAYMENT' && order.paymentMethod === 'BANK_TRANSFER') {
    return (
      <Card className="border-primary/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="size-5" /> {t('bankTransfer.title')}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('bankTransfer.intro', {
              date: order.paymentDueAt
                ? format.dateTime(order.paymentDueAt, { dateStyle: 'full' })
                : '–',
            })}
          </p>
        </CardHeader>
        <CardContent>
          {bank ? (
            <BankTransferDetails
              bank={bank}
              amountText={money(view.outstanding)}
              amountCents={view.outstanding}
              reference={order.paymentReference ?? ''}
              labels={bankLabels(t)}
            />
          ) : (
            <p className="text-sm">{t('bankTransfer.noAccount')}</p>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            {t(order.autoCancelAt ? 'bankTransfer.hint' : 'bankTransfer.hintNoCancel')}
          </p>
        </CardContent>
      </Card>
    );
  }
  if (order.status === 'PENDING' && order.paymentMethod === 'PAYPAL') {
    return (
      <Card className="border-primary/40">
        <CardHeader>
          <CardTitle>{t('paypal.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {view.paypal.payable
              ? t('paypal.intro', {
                  time: format.dateTime(new Date(view.paypal.expiresAt!), { timeStyle: 'short' }),
                })
              : t('paypal.processing')}
          </p>
        </CardHeader>
        <CardContent>
          {view.paypal.payable && <OrderPaymentActions orderId={order.id} token={token} />}
        </CardContent>
      </Card>
    );
  }
  return null;
}

function AdjustmentCard({
  orderId,
  adjustment,
  placeByItem,
  money,
  token,
  t,
}: {
  orderId: string;
  adjustment: NonNullable<OrderView['adjustment']>;
  placeByItem: Map<string, string>;
  money: (cents: number) => string;
  token: string | null;
  t: Awaited<ReturnType<typeof getTranslations<'checkout.order'>>>;
}) {
  const bank = adjustment.payment?.bank ?? null;
  const paypal = adjustment.payment?.paypal ?? false;
  return (
    <Card className="border-warning-border">
      <CardHeader>
        <CardTitle>{t('adjustment.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('adjustment.intro')}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <ul className="space-y-2 text-sm">
          {adjustment.items.map((item) => (
            <li key={item.orderItemId} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <span>
                {placeByItem.get(item.orderItemId) ?? ''}
                <span className="block text-xs text-muted-foreground">
                  {item.fromName} → {item.toName}
                </span>
              </span>
              <span className="whitespace-nowrap tabular-nums">
                <span className="text-muted-foreground line-through">
                  {money(item.fromPriceGross)}
                </span>{' '}
                → <span className="font-medium">{money(item.toPriceGross)}</span>
              </span>
            </li>
          ))}
        </ul>
        {adjustment.reason && (
          <p className="text-sm text-muted-foreground">
            {t('adjustment.reason', { reason: adjustment.reason })}
          </p>
        )}
        {adjustment.creditApplied > 0 && (
          <div className="space-y-1 border-t pt-3 text-sm text-muted-foreground">
            <div className="flex justify-between">
              <span>{t('adjustment.difference')}</span>
              <span className="tabular-nums">
                {money(adjustment.amount + adjustment.creditApplied)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{t('adjustment.alreadyPaid')}</span>
              <span className="tabular-nums">−{money(adjustment.creditApplied)}</span>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between border-t pt-3 text-base font-semibold">
          <span>
            {adjustment.creditApplied > 0 ? t('adjustment.rest') : t('adjustment.amount')}
          </span>
          <span className="tabular-nums">{money(adjustment.amount)}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t('adjustment.ticketsStayValid')}</p>

        {adjustment.status === 'PROPOSED' ? (
          <div className="space-y-2">
            <AdjustmentConfirmButton orderId={orderId} adjustmentId={adjustment.id} token={token} />
            <p className="text-xs text-muted-foreground">{t('adjustment.confirmHint')}</p>
          </div>
        ) : (
          <div className="space-y-5">
            {paypal && (
              <div className="space-y-2">
                <AdjustmentPayPalButton
                  orderId={orderId}
                  adjustmentId={adjustment.id}
                  token={token}
                />
              </div>
            )}
            {bank && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">{t('adjustment.bankTitle')}</h3>
                <BankTransferDetails
                  bank={bank}
                  amountText={money(adjustment.amount)}
                  amountCents={adjustment.amount}
                  reference={adjustment.paymentReference}
                  labels={bankLabels(t)}
                />
                <p className="text-xs text-muted-foreground">{t('adjustment.bankHint')}</p>
              </div>
            )}
            {!paypal && !bank && <p className="text-sm">{t('adjustment.noMethod')}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const bankLabels = (t: Awaited<ReturnType<typeof getTranslations<'checkout.order'>>>) => ({
  amount: t('bankTransfer.amount'),
  reference: t('bankTransfer.reference'),
  holder: t('bankTransfer.holder'),
  bank: t('bankTransfer.bank'),
});
