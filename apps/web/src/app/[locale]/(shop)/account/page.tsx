import { getSetting, listCustomerOrders, type CustomerOrderSummary } from '@tix/core';
import { EmailText } from '@/components/email-text';
import { CircleCheck, Download, KeyRound, MailWarning, Ticket } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link, redirect } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { getCustomerSessionRecord } from '@/server/customer-session';
import {
  PasswordForm,
  ProfileForm,
  ResendVerificationForm,
  SignOutButton,
} from './_components/account-forms';
import { searchParam } from './_components/auth-card';

export async function generateMetadata() {
  const t = await getTranslations('account.overview');
  return { title: t('title'), robots: { index: false } };
}

const ORDERS_PER_PAGE = 10;
/** An event still counts as upcoming for this long after its start (doors, long shows). */
const UPCOMING_GRACE_MS = 12 * 3600_000;

/** Orders with an upcoming event first (soonest first), then the rest newest first. */
function sortOrders(list: CustomerOrderSummary[], now: number): CustomerOrderSummary[] {
  const nextStart = (order: CustomerOrderSummary): number | null => {
    const starts = order.events
      .map((e) => e.startsAt.getTime())
      .filter((time) => time >= now - UPCOMING_GRACE_MS);
    return starts.length > 0 ? Math.min(...starts) : null;
  };
  const upcoming = list
    .map((order) => ({ order, next: nextStart(order) }))
    .filter((x): x is { order: CustomerOrderSummary; next: number } => x.next !== null)
    .sort((a, b) => a.next - b.next)
    .map((x) => x.order);
  const rest = list.filter((order) => nextStart(order) === null);
  return [...upcoming, ...rest];
}

const STATUS_VARIANT: Record<
  CustomerOrderSummary['status'],
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  PENDING: 'outline',
  AWAITING_PAYMENT: 'secondary',
  PAID: 'default',
  PARTIALLY_REFUNDED: 'secondary',
  REFUNDED: 'outline',
  CANCELLED: 'destructive',
  EXPIRED: 'outline',
};

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await resolveLocale(params);
  const session = await getCustomerSessionRecord();
  if (!session) {
    return redirect({ href: `/account/login?next=${encodeURIComponent('/account')}`, locale });
  }
  const core = getCore();
  const [t, format, settings, organizer, orders] = await Promise.all([
    getTranslations('account'),
    getFormatter(),
    getSetting(core, 'customerAccounts'),
    getSetting(core, 'organizer'),
    session.emailVerified
      ? listCustomerOrders(core, session.customerId, { locale })
      : Promise.resolve([]),
  ]);
  const query = await searchParams;
  const passwordReset = searchParam(query, 'passwordReset') === '1';
  const sortedOrders = sortOrders(orders, Date.now());
  const pageCount = Math.max(1, Math.ceil(sortedOrders.length / ORDERS_PER_PAGE));
  const requestedPage = Number.parseInt(searchParam(query, 'page') ?? '1', 10);
  const page = Math.min(Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1), pageCount);
  const pageOrders = sortedOrders.slice((page - 1) * ORDERS_PER_PAGE, page * ORDERS_PER_PAGE);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('overview.title')}</h1>
          <EmailText
            as="p"
            className="text-sm text-muted-foreground"
            text={t('overview.signedInAs', {
              name: `${session.firstName} ${session.lastName}`.trim(),
              email: session.email,
            })}
          />
        </div>
        <SignOutButton />
      </div>

      {passwordReset && (
        <Alert>
          <CircleCheck />
          <AlertDescription>{t('overview.passwordReset')}</AlertDescription>
        </Alert>
      )}
      {!session.emailVerified && (
        <Alert>
          <MailWarning />
          <AlertTitle>{t('overview.unverifiedTitle')}</AlertTitle>
          <AlertDescription className="space-y-3">
            <EmailText as="p" text={t('overview.unverified', { email: session.email })} />
            <ResendVerificationForm next="/account" />
          </AlertDescription>
        </Alert>
      )}
      {!session.hasPassword && (
        <Alert>
          <KeyRound />
          <AlertTitle>{t('overview.noPasswordTitle')}</AlertTitle>
          <AlertDescription>{t('overview.noPassword')}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('orders.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {!session.emailVerified ? (
            <p className="text-sm text-muted-foreground">{t('orders.unverified')}</p>
          ) : orders.length === 0 ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>{t('orders.empty')}</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/">{t('orders.browse')}</Link>
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {pageOrders.map((order) => (
                <li
                  key={order.id}
                  className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {t('orders.number', { number: order.orderNumber })}
                      </span>
                      <Badge variant={STATUS_VARIANT[order.status]}>
                        {t(`orders.status.${order.status}`)}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('orders.placedOn', {
                        date: format.dateTime(order.createdAt, { dateStyle: 'medium' }),
                      })}
                      {' · '}
                      {t(`orders.method.${order.paymentMethod}`)}
                      {' · '}
                      {t('orders.tickets', { count: order.ticketCount })}
                    </p>
                    <ul className="space-y-0.5 text-sm">
                      {order.events.map((event) => (
                        <li key={event.eventId} className="flex items-start gap-2">
                          <Ticket className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                          <span>
                            <span className="font-medium">{event.title}</span>
                            <span className="text-muted-foreground">
                              {' – '}
                              {format.dateTime(event.startsAt, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                                timeZone: event.timeZone,
                              })}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end">
                    <span className="font-semibold tabular-nums">
                      {format.number(order.totalGross / 100, {
                        style: 'currency',
                        currency: order.currency,
                      })}
                    </span>
                    <div className="flex flex-wrap gap-2 sm:justify-end">
                      {order.validTicketCount > 0 && (
                        <Button asChild size="sm" variant="outline">
                          <a href={`/api/orders/${order.id}/tickets`}>
                            <Download className="size-4" />
                            {t('orders.downloadTickets')}
                          </a>
                        </Button>
                      )}
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/orders/${encodeURIComponent(order.orderNumber)}`}>
                          {t('orders.view')}
                        </Link>
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {pageCount > 1 && (
            <nav
              aria-label={t('orders.paginationLabel')}
              className="mt-4 flex items-center justify-between gap-2 border-t pt-4 text-sm"
            >
              {page > 1 ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/account?page=${page - 1}`}>{t('orders.previousPage')}</Link>
                </Button>
              ) : (
                <span />
              )}
              <span className="text-muted-foreground">
                {t('orders.pageOf', { page, pages: pageCount })}
              </span>
              {page < pageCount ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/account?page=${page + 1}`}>{t('orders.nextPage')}</Link>
                </Button>
              ) : (
                <span />
              )}
            </nav>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.title')}</CardTitle>
            <CardDescription>{t('profile.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileForm
              email={session.email}
              firstName={session.firstName}
              lastName={session.lastName}
              phone={session.phone}
              address={session.address}
              defaultCountry={organizer.country}
            />
          </CardContent>
        </Card>
        <Card className="self-start">
          <CardHeader>
            <CardTitle>{t('password.title')}</CardTitle>
            <CardDescription>
              {session.hasPassword ? t('password.changeDescription') : t('password.setDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PasswordForm
              hasPassword={session.hasPassword}
              adminConfirm={!session.hasPassword && session.linkedAdminUserId !== null}
              minLength={settings.passwordMinLength}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
