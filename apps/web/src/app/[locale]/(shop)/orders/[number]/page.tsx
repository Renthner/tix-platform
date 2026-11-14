import {
  findOrderIdByNumber,
  getSetting,
  getOrderView,
  walletAvailability,
  walletTicketPath,
  type OrderView,
} from '@tix/core';
import { formatTicketCode } from '@tix/shared';
import { CheckCircle2, Clock, Download, Info, Undo2, XCircle } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CopyValue, OrderPaymentActions } from '@/components/shop/order-actions';
import {
  AdjustmentConfirmButton,
  AdjustmentPayPalButton,
} from '@/components/shop/order-adjustment';
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

const groupIban = (iban: string) => iban.replace(/(.{4})(?=.)/g, '$1 ');

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; number: string }>;
  searchParams: Promise<{ t?: string; paypal?: string; wallet?: string }>;
}) {
  await resolveLocale(params);
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
  const placeByItem = new Map(
    view.events.flatMap((event) =>
      event.items.map((item) => [
        item.id,
        item.kind === 'SEAT'
          ? [
              item.sectionLabel,
              item.rowLabel ? t('items.row', { label: item.rowLabel }) : null,
              t('items.seat', { label: item.seatLabel ?? '' }),
            ]
              .filter(Boolean)
              .join(' · ')
          : `${item.sectionLabel} · ${t('items.standing')}`,
      ]),
    ),
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
  const tokenQuery = token ? `?t=${encodeURIComponent(token)}` : '';

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

      <StatusCard view={view} money={money} token={token ?? null} format={format} t={t} />

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

      <Card>
        <CardHeader>
          <CardTitle>{t('items.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {view.events.map((event) => (
            <div key={event.eventId} className="space-y-2">
              <div>
                <div className="font-medium">{event.title}</div>
                <div className="text-sm text-muted-foreground">
                  {format.dateTime(new Date(event.startsAt), {
                    dateStyle: 'full',
                    timeStyle: 'short',
                    timeZone: event.timeZone,
                  })}{' '}
                  · {event.venueName}
                </div>
              </div>
              <ul className="divide-y text-sm">
                {event.items.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div
                        className={
                          item.status === 'CANCELLED' || item.status === 'REFUNDED'
                            ? 'line-through'
                            : undefined
                        }
                      >
                        {item.kind === 'SEAT'
                          ? [
                              item.sectionLabel,
                              item.rowLabel ? t('items.row', { label: item.rowLabel }) : null,
                              t('items.seat', { label: item.seatLabel ?? '' }),
                            ]
                              .filter(Boolean)
                              .join(' · ')
                          : `${item.sectionLabel} · ${t('items.standing')}`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {item.categoryName} · {item.ticketTypeName}
                        {item.status === 'REFUNDED' && ` · ${t('items.refundedItem')}`}
                      </div>
                    </div>
                    <span className="tabular-nums">{money(item.priceGross)}</span>
                  </li>
                ))}
                {view.fees
                  .filter((fee) => fee.eventId === event.eventId)
                  .map((fee) => (
                    <li
                      key={fee.id}
                      className="flex justify-between gap-3 py-2 text-muted-foreground"
                    >
                      <span>
                        {fee.name}
                        {fee.quantity > 1 && ` (${fee.quantity}×)`}
                      </span>
                      <span className="tabular-nums">{money(fee.totalGross)}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          <div className="space-y-1 border-t pt-3 text-sm">
            {view.fees
              .filter((fee) => fee.eventId === null)
              .map((fee) => (
                <div key={fee.id} className="flex justify-between text-muted-foreground">
                  <span>{fee.name}</span>
                  <span className="tabular-nums">{money(fee.totalGross)}</span>
                </div>
              ))}
            <div className="flex justify-between text-base font-semibold">
              <span>{t('items.total')}</span>
              <span className="tabular-nums">{money(order.totalGross)}</span>
            </div>
            {view.taxes
              .filter((tax) => tax.rateBasisPoints > 0 && tax.tax > 0)
              .map((tax) => (
                <div
                  key={tax.rateBasisPoints}
                  className="flex justify-between text-xs text-muted-foreground"
                >
                  <span>{t('items.vat', { rate: tax.rateBasisPoints / 100 })}</span>
                  <span className="tabular-nums">{money(tax.tax)}</span>
                </div>
              ))}
            {order.amountPaid > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>{t('items.paid')}</span>
                <span className="tabular-nums">{money(order.amountPaid)}</span>
              </div>
            )}
            {order.amountRefunded > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>{t('items.refunded')}</span>
                <span className="tabular-nums">−{money(order.amountRefunded)}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {issuedTickets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('tickets.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('tickets.intro')}</p>
            <div className="pt-1" data-slot="ticket-downloads-all">
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
                  </div>
                  <div className="flex items-center gap-2" data-slot="ticket-downloads">
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
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

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
                    href={`/api/orders/${order.id}/invoices/${invoice.id}${tokenQuery}`}
                    className="inline-flex items-center gap-2 hover:underline"
                  >
                    <Download className="size-4" />
                    {invoice.isCorrection && invoice.correctsNumber
                      ? t('documents.correction', {
                          number: invoice.invoiceNumber,
                          invoice: invoice.correctsNumber,
                        })
                      : t(
                          invoice.type === 'CREDIT_NOTE'
                            ? 'documents.creditNote'
                            : 'documents.invoice',
                          { number: invoice.invoiceNumber },
                        )}
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">{t('contact', { email: order.email ?? '' })}</p>
    </div>
  );
}

function StatusCard({
  view,
  money,
  token,
  format,
  t,
}: {
  view: OrderView;
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
        <AlertDescription>{t('paid.text', { email: order.email ?? '' })}</AlertDescription>
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
    const account = view.bankAccount;
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
          {account ? (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[180px_1fr]">
              <dt className="text-muted-foreground">{t('bankTransfer.amount')}</dt>
              <dd>
                <CopyValue
                  value={money(view.outstanding)}
                  copyText={(view.outstanding / 100).toFixed(2)}
                  strong
                />
              </dd>
              <dt className="text-muted-foreground">{t('bankTransfer.reference')}</dt>
              <dd>
                <CopyValue value={order.paymentReference ?? ''} strong />
              </dd>
              <dt className="text-muted-foreground">{t('bankTransfer.holder')}</dt>
              <dd>
                <CopyValue value={account.accountHolder} />
              </dd>
              <dt className="text-muted-foreground">IBAN</dt>
              <dd>
                <CopyValue value={groupIban(account.iban)} copyText={account.iban} mono />
              </dd>
              {account.bic && (
                <>
                  <dt className="text-muted-foreground">BIC</dt>
                  <dd>
                    <CopyValue value={account.bic} mono />
                  </dd>
                </>
              )}
              {account.bankName && (
                <>
                  <dt className="text-muted-foreground">{t('bankTransfer.bank')}</dt>
                  <dd>{account.bankName}</dd>
                </>
              )}
            </dl>
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
                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[180px_1fr]">
                  <dt className="text-muted-foreground">{t('bankTransfer.amount')}</dt>
                  <dd>
                    <CopyValue
                      value={money(adjustment.amount)}
                      copyText={(adjustment.amount / 100).toFixed(2)}
                      strong
                    />
                  </dd>
                  <dt className="text-muted-foreground">{t('bankTransfer.reference')}</dt>
                  <dd>
                    <CopyValue value={adjustment.paymentReference} strong />
                  </dd>
                  <dt className="text-muted-foreground">{t('bankTransfer.holder')}</dt>
                  <dd>
                    <CopyValue value={bank.holder} />
                  </dd>
                  <dt className="text-muted-foreground">IBAN</dt>
                  <dd>
                    <CopyValue value={groupIban(bank.iban)} copyText={bank.iban} mono />
                  </dd>
                  {bank.bic && (
                    <>
                      <dt className="text-muted-foreground">BIC</dt>
                      <dd>
                        <CopyValue value={bank.bic} mono />
                      </dd>
                    </>
                  )}
                  {bank.bankName && (
                    <>
                      <dt className="text-muted-foreground">{t('bankTransfer.bank')}</dt>
                      <dd>{bank.bankName}</dd>
                    </>
                  )}
                </dl>
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
