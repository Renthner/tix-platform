import { getEventOverviewStats, summarizeTestOrders } from '@tix/core';
import {
  ClipboardList,
  ExternalLink,
  FlaskConical,
  ListOrdered,
  PencilRuler,
  ScanLine,
  Users,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { EventPublishCard } from '@/components/admin/event-publish-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { Link } from '@/i18n/navigation';
import { formatInZone } from '@/lib/datetime';
import { formatMoney } from '@/lib/money';
import { hasRole, requireAdmin } from '@/server/auth';
import { getEventWithVenue } from '@/server/admin/queries';
import { getCore } from '@/server/core';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const row = await getEventWithVenue((await params).id);
  return { title: row?.event.title ?? '–' };
}

/** Calendar day (YYYY-MM-DD) of a moment in a time zone. */
function dayInZone(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function Kpi({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  testId: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      {detail ? <dd className="mt-1 text-xs text-muted-foreground">{detail}</dd> : null}
    </div>
  );
}

/** Event overview: key figures, publishing, dates and quick links (test orders excluded). */
export default async function EventOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ duplicated?: string; imported?: string }>;
}) {
  const locale = await resolveLocale(params);
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const { duplicated, imported } = await searchParams;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const { event, venue } = row;
  const core = getCore();
  const [t, te, stats, testOrders] = await Promise.all([
    getTranslations('admin.events.overview'),
    getTranslations('admin.events'),
    getEventOverviewStats(core, event.id),
    summarizeTestOrders(core, event.id),
  ]);
  const isSuperAdmin = hasRole(session, ['SUPER_ADMIN']);
  const tz = event.timeZone;
  const base = `/admin/events/${event.id}`;
  const inv = stats.inventory;
  const showCheckIn =
    stats.checkIn.checkedIn > 0 || dayInZone(event.startsAt, tz) <= dayInZone(new Date(), tz);
  const shopHref = `/events/${event.slug}`;
  const testable =
    isSuperAdmin &&
    (event.status === 'DRAFT' || event.status === 'PUBLISHED' || event.status === 'POSTPONED');
  const published = event.status === 'PUBLISHED' || event.status === 'POSTPONED';
  const date = (d: Date | null) => (d ? formatInZone(d, tz, locale) : t('facts.notSet'));

  const facts: [string, string][] = [
    [t('facts.starts'), date(event.startsAt)],
    ...(event.endsAt ? [[t('facts.ends'), date(event.endsAt)] as [string, string]] : []),
    [t('facts.doors'), date(event.doorsOpenAt)],
    ...(event.presaleStartsAt
      ? [[t('facts.presale'), date(event.presaleStartsAt)] as [string, string]]
      : []),
    [t('facts.publicSale'), date(event.publicSaleStartsAt)],
    [t('facts.saleEnds'), date(event.saleEndsAt)],
  ];
  const linkClass =
    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

  return (
    // Container queries: the content pane is narrower than the window (event menu next to it).
    <div className="@container space-y-6" data-testid="event-overview">
      {duplicated && (
        <Alert>
          <AlertDescription>{te('duplicate.notice')}</AlertDescription>
        </Alert>
      )}
      {imported && (
        <Alert>
          <AlertDescription>{te('transfer.import.notice')}</AlertDescription>
        </Alert>
      )}

      <section aria-label={t('kpis.label')} className="space-y-2">
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
          <Kpi
            testId="event-kpi-sold"
            label={t('kpis.sold')}
            value={inv.sold}
            detail={t('kpis.soldOf', { capacity: inv.capacity })}
          />
          <Kpi
            testId="event-kpi-reserved"
            label={t('kpis.reserved')}
            value={inv.reserved + inv.locked}
            detail={t('kpis.reservedDetail', { pending: inv.reserved, locked: inv.locked })}
          />
          <Kpi
            testId="event-kpi-available"
            label={t('kpis.available')}
            value={inv.available}
            detail={[
              inv.blocked > 0 ? t('kpis.blocked', { count: inv.blocked }) : null,
              inv.testHeld > 0 ? t('kpis.testHeld', { count: inv.testHeld }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
          <Kpi
            testId="event-kpi-revenue"
            label={t('kpis.revenue')}
            value={formatMoney(stats.revenueCents, event.currency, locale)}
            detail={t('kpis.revenueHint')}
          />
          {showCheckIn && (
            <Kpi
              testId="event-kpi-check-in"
              label={t('kpis.checkIn')}
              value={stats.checkIn.checkedIn}
              detail={
                <>
                  <span className="block">
                    {t('kpis.checkInOf', { valid: stats.checkIn.valid })}
                  </span>
                  <span
                    className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted"
                    aria-hidden
                  >
                    <span
                      className="block h-full bg-primary"
                      style={{
                        width: `${stats.checkIn.valid > 0 ? Math.round((stats.checkIn.checkedIn / stats.checkIn.valid) * 100) : 0}%`,
                      }}
                    />
                  </span>
                </>
              }
            />
          )}
        </dl>
        {(testOrders.orders > 0 || testOrders.hidden > 0) && (
          <p className="text-xs text-muted-foreground">{t('kpis.testExcluded')}</p>
        )}
      </section>

      <div className="grid gap-6 @4xl:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('facts.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {event.salesPaused && (
                <Alert className="border-warning-border bg-warning-soft text-warning">
                  <AlertDescription>{t('facts.paused')}</AlertDescription>
                </Alert>
              )}
              <dl className="grid gap-x-6 gap-y-3 text-sm @xl:grid-cols-2">
                {facts.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-xs text-muted-foreground">{t('facts.venue')}</dt>
                  <dd>
                    {venue ? (
                      <Link href={`/admin/venues/${venue.id}`} className="hover:underline">
                        {venue.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('facts.seatPlan')}</dt>
                  <dd>
                    {event.seatingMode === 'ADMISSION' ? (
                      <Link
                        href={`/admin/events/${event.id}/seating`}
                        className="inline-flex items-center gap-1 hover:underline"
                      >
                        {t('facts.contingents')}
                      </Link>
                    ) : event.seatMapId ? (
                      <Link
                        href={`/admin/seat-maps/${event.seatMapId}`}
                        className="inline-flex items-center gap-1 hover:underline"
                      >
                        <PencilRuler className="size-3.5" aria-hidden /> {t('facts.openEditor')}
                      </Link>
                    ) : (
                      t('facts.noPlan')
                    )}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('links.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-1 @xl:grid-cols-2" data-testid="event-quick-links">
                <li>
                  <Link href={`/admin/orders?event=${event.id}`} className={linkClass}>
                    <ListOrdered className="size-4 text-muted-foreground" aria-hidden />
                    {t('links.orders')}
                  </Link>
                </li>
                <li>
                  <Link href={`${base}/sales`} className={linkClass}>
                    <Users className="size-4 text-muted-foreground" aria-hidden />
                    {t('links.waitlist', { count: stats.waitlistConfirmed })}
                  </Link>
                </li>
                <li>
                  <Link href={`${base}/check-in`} className={linkClass}>
                    <ScanLine className="size-4 text-muted-foreground" aria-hidden />
                    {t('links.checkIn')}
                  </Link>
                </li>
                {isSuperAdmin && testOrders.orders > 0 && (
                  <li>
                    <Link href={`/admin/orders?event=${event.id}&tests=only`} className={linkClass}>
                      <ClipboardList className="size-4 text-muted-foreground" aria-hidden />
                      {t('links.testOrders', { count: testOrders.orders })}
                    </Link>
                  </li>
                )}
                {testable && (
                  <li>
                    <Link href={shopHref} target="_blank" rel="noopener" className={linkClass}>
                      <FlaskConical className="size-4 text-muted-foreground" aria-hidden />
                      {te('testInShop')}
                    </Link>
                  </li>
                )}
                {published && (
                  <li>
                    <Link href={shopHref} target="_blank" rel="noopener" className={linkClass}>
                      <ExternalLink className="size-4 text-muted-foreground" aria-hidden />
                      {te('viewInShop')}
                    </Link>
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>

        <EventPublishCard
          event={event}
          testOrders={testOrders}
          canDeleteTestOrders={isSuperAdmin}
          footer={
            <Link
              href={`${base}/status`}
              className="block text-sm underline-offset-4 hover:underline"
            >
              {t('statusLink')}
            </Link>
          }
        />
      </div>
    </div>
  );
}
