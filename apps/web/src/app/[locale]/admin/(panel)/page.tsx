import {
  computeSaleState,
  countAdjustmentsNeedingAttention,
  countInvoiceCorrections,
  countOpenRefunds,
  countRefundRestoreReviews,
  getRefundReconcileStatus,
  getBackupFailure,
  getSetupChecklist,
} from '@tix/core';
import {
  Activity,
  Building2,
  CalendarPlus,
  ChartLine,
  DatabaseBackup,
  Hourglass,
  Undo2,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { EventStatusBadge, SaleStateBadge } from '@/components/admin/badges';
import { PageHeader } from '@/components/admin/form-controls';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { LiveDashboard } from '@/components/admin/live-dashboard';
import { SetupChecklistCard } from '@/components/admin/setup-checklist-card';
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
import { formatInZone } from '@/lib/datetime';
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { loadDashboard } from '@/server/admin/dashboard';
import { listEvents } from '@/server/admin/queries';

export async function generateMetadata() {
  const t = await getTranslations('admin.dashboard');
  return { title: t('title') };
}

export default async function AdminDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ denied?: string }>;
}) {
  const locale = await resolveLocale(params);
  const session = await requireAdmin();
  const { denied } = await searchParams;
  const [
    t,
    tb,
    upcoming,
    openRefunds,
    openAdjustments,
    invoiceCorrections,
    backupFailure,
    live,
    refundReviews,
    reconcile,
    setup,
  ] = await Promise.all([
    getTranslations('admin.dashboard'),
    getTranslations('backups.dashboardAlert'),
    listEvents({ upcomingOnly: true }),
    hasRole(session, ['FINANCE']) ? countOpenRefunds(getCore()) : Promise.resolve(0),
    hasRole(session, ['FINANCE'])
      ? countAdjustmentsNeedingAttention(getCore())
      : Promise.resolve(0),
    hasRole(session, ['FINANCE']) ? countInvoiceCorrections(getCore()) : Promise.resolve(0),
    hasRole(session, ['SUPER_ADMIN'])
      ? getBackupFailure(getCore()).catch(() => null)
      : Promise.resolve(null),
    loadDashboard(session).catch(() => null),
    hasRole(session, ['FINANCE'])
      ? countRefundRestoreReviews(getCore()).catch(() => 0)
      : Promise.resolve(0),
    hasRole(session, ['FINANCE'])
      ? getRefundReconcileStatus(getCore()).catch(() => null)
      : Promise.resolve(null),
    // Same role as the settings pages; a failing probe must never break the dashboard.
    session.roles.includes('SUPER_ADMIN')
      ? getSetupChecklist(getCore(), session.userId).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader title={t('title')} description={t('welcome', { name: session.displayName })} />
      <div className="space-y-6 p-6">
        {(hasRole(session, ['EVENT_MANAGER', 'FINANCE']) || hasRole(session, ['SUPER_ADMIN'])) && (
          <div className="flex flex-wrap gap-2">
            {hasRole(session, ['EVENT_MANAGER', 'FINANCE']) && (
              <Button asChild variant="outline" size="sm">
                <Link href="/admin/statistics">
                  <ChartLine className="size-4" />
                  {t('analytics.statistics')}
                </Link>
              </Button>
            )}
            {hasRole(session, ['SUPER_ADMIN']) && (
              <Button asChild variant="outline" size="sm">
                <Link href="/admin/system">
                  <Activity className="size-4" />
                  {t('analytics.system')}
                </Link>
              </Button>
            )}
          </div>
        )}
        {denied && (
          <Alert variant="destructive">
            <AlertDescription>{t('denied')}</AlertDescription>
          </Alert>
        )}
        {setup && !setup.allDone && (
          <SetupChecklistCard checklist={setup} canDismiss={hasRole(session, ['SUPER_ADMIN'])} />
        )}
        {backupFailure && (
          <Alert variant="destructive">
            <DatabaseBackup className="size-4" />
            <AlertTitle>{tb('title')}</AlertTitle>
            <AlertDescription>
              <span>{tb('text', { message: backupFailure.message })}</span>{' '}
              <Link href="/admin/backups" className="font-medium underline">
                {tb('link')}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        {(refundReviews > 0 || reconcile?.pending) && (
          <Alert variant="destructive">
            <Undo2 className="size-4" />
            <AlertTitle>
              {reconcile?.pending
                ? t('refundReconcile.pendingTitle')
                : t('refundReconcile.reviewTitle', { count: refundReviews })}
            </AlertTitle>
            <AlertDescription>
              <span>
                {reconcile?.pending
                  ? reconcile.lastError || reconcile.alert
                    ? t('refundReconcile.failing', { error: reconcile.lastError ?? '' })
                    : t('refundReconcile.pendingText')
                  : t('refundReconcile.reviewText')}
              </span>{' '}
              <Link href="/admin/refunds" className="font-medium underline">
                {t('refundsOpen.link')}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        {openRefunds > 0 && (
          <Alert variant="destructive">
            <Undo2 className="size-4" />
            <AlertTitle>{t('refundsOpen.title', { count: openRefunds })}</AlertTitle>
            <AlertDescription>
              <span>{t('refundsOpen.text')}</span>{' '}
              <Link href="/admin/refunds" className="font-medium underline">
                {t('refundsOpen.link')}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        {invoiceCorrections > 0 && (
          <Alert variant="destructive">
            <Undo2 className="size-4" />
            <AlertTitle>{t('invoiceCorrections.title', { count: invoiceCorrections })}</AlertTitle>
            <AlertDescription>
              <span>{t('invoiceCorrections.text')}</span>{' '}
              <Link href="/admin/refunds" className="font-medium underline">
                {t('invoiceCorrections.link')}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        {openAdjustments > 0 && (
          <Alert variant="destructive">
            <Undo2 className="size-4" />
            <AlertTitle>{t('adjustmentsOpen.title', { count: openAdjustments })}</AlertTitle>
            <AlertDescription>
              <span>{t('adjustmentsOpen.text')}</span>{' '}
              <Link href="/admin/refunds" className="font-medium underline">
                {t('adjustmentsOpen.link')}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/admin/events/new">
              <CalendarPlus /> {t('links.newEvent')}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/venues">
              <Building2 /> {t('links.venues')}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/waiting-room">
              <Hourglass /> {t('links.waitingRoom')}
            </Link>
          </Button>
        </div>
        {live && <LiveDashboard initial={live} />}
        <Card>
          <CardHeader>
            <CardTitle>{t('upcoming')}</CardTitle>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">{t('noEvents')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.event')}</TableHead>
                    <TableHead>{t('columns.date')}</TableHead>
                    <TableHead>{t('columns.venue')}</TableHead>
                    <TableHead>{t('columns.status')}</TableHead>
                    <TableHead>{t('columns.sale')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcoming.slice(0, 20).map(({ event, venueName }) => (
                    <TableRow
                      key={event.id}
                      className="relative cursor-pointer focus-within:bg-muted/50"
                    >
                      <TableCell className="font-medium">
                        <Link
                          href={`/admin/events/${event.id}`}
                          className="outline-none after:absolute after:inset-0 hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                        >
                          {event.title}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatInZone(event.startsAt, event.timeZone, locale)}
                      </TableCell>
                      <TableCell>{venueName}</TableCell>
                      <TableCell>
                        <EventStatusBadge status={event.status} />
                      </TableCell>
                      <TableCell>
                        <SaleStateBadge state={computeSaleState(event)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
