import {
  countRefundRestoreReviews,
  getRefundReconcileStatus,
  getBackupFailure,
  getSetupChecklist,
} from '@tix/core';
import { DatabaseBackup, FileWarning, Rocket, ShieldAlert, Undo2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DashboardAttention } from '@/components/admin/dashboard-attention';
import { AdminPageHeader } from '@/components/admin/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { LiveDashboard } from '@/components/admin/live-dashboard';
import { SetupChecklistCard } from '@/components/admin/setup-checklist-card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { loadDashboard } from '@/server/admin/dashboard';
import { loadAdminShellData } from '@/server/admin/shell';
import { loadUpdateNotice } from '@/server/updates';

export async function generateMetadata() {
  const t = await getTranslations('admin.dashboard');
  return { title: t('overview') };
}

/**
 * Admin start page, top → bottom: system alerts (only when present), "Needs attention" (open
 * to-dos only), live KPIs and one compact table of the events in scope; the "First steps"
 * checklist sits in a side column on wide screens.
 */
export default async function AdminDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ denied?: string }>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin();
  const { denied } = await searchParams;
  const finance = hasRole(session, ['FINANCE']);
  const eventManager = hasRole(session, ['EVENT_MANAGER']);
  const superAdmin = hasRole(session, ['SUPER_ADMIN']);
  const [t, tb, tu, shell, backupFailure, live, refundReviews, reconcile, setup, updates] =
    await Promise.all([
      getTranslations('admin.dashboard'),
      getTranslations('backups.dashboardAlert'),
      getTranslations('admin.dashboard.updates'),
      // Same (request-cached) data as the notification bell.
      loadAdminShellData(),
      superAdmin ? getBackupFailure(getCore()).catch(() => null) : Promise.resolve(null),
      loadDashboard(session).catch(() => null),
      finance ? countRefundRestoreReviews(getCore()).catch(() => 0) : Promise.resolve(0),
      finance ? getRefundReconcileStatus(getCore()).catch(() => null) : Promise.resolve(null),
      // Same role as the settings pages; a failing probe must never break the dashboard.
      session.roles.includes('SUPER_ADMIN')
        ? getSetupChecklist(getCore(), session.userId).catch(() => null)
        : Promise.resolve(null),
      // Super admins only; answers from the cache and never waits for GitHub.
      session.roles.includes('SUPER_ADMIN') ? loadUpdateNotice() : Promise.resolve(null),
    ]);
  const showChecklist = Boolean(setup && !setup.allDone);
  const updateAvailable =
    updates?.status.status === 'ok' && updates.status.latest && updates.status.updateAvailable
      ? updates.status.latest
      : null;
  const pinnedNewer =
    updates?.status.status === 'ok' &&
    updates.status.pinned &&
    updates.status.latest &&
    updates.status.latest.version !== updates.status.current
      ? updates.status.latest
      : null;

  const alertLink = 'font-medium underline';
  const alerts = [
    denied && (
      <Alert key="denied" variant="destructive">
        <ShieldAlert className="size-4" />
        <AlertDescription>{t('denied')}</AlertDescription>
      </Alert>
    ),
    backupFailure && (
      <Alert key="backup" variant="destructive">
        <DatabaseBackup className="size-4" />
        <AlertTitle>{tb('title')}</AlertTitle>
        <AlertDescription>
          <span>{tb('text', { message: backupFailure.message })}</span>{' '}
          <Link href="/admin/backups" className={alertLink}>
            {tb('link')}
          </Link>
        </AlertDescription>
      </Alert>
    ),
    (refundReviews > 0 || reconcile?.pending) && (
      <Alert key="reconcile" variant="destructive">
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
          <Link href="/admin/refunds" className={alertLink}>
            {t('refundReconcile.link')}
          </Link>
        </AlertDescription>
      </Alert>
    ),
    updates?.drift && (
      <Alert key="drift" className="border-warning-border bg-warning-soft text-warning">
        <FileWarning className="size-4" />
        <AlertTitle>{tu('drift.title')}</AlertTitle>
        <AlertDescription>
          <span>
            {tu('drift.text', {
              composeVersion: updates.drift.composeVersion,
              appVersion: updates.drift.appVersion,
            })}
          </span>{' '}
          {updates.drift.downloadUrl && (
            <a href={updates.drift.downloadUrl} className={alertLink} rel="noopener noreferrer">
              {tu('drift.link', { version: updates.drift.appVersion })}
            </a>
          )}
        </AlertDescription>
      </Alert>
    ),
    updateAvailable && updates?.status.status === 'ok' && (
      <Alert key="update">
        <Rocket className="size-4" />
        <AlertTitle>
          {tu('available.title', {
            version: updateAvailable.version,
            channel: updates.status.channel,
          })}
        </AlertTitle>
        <AlertDescription>
          <span>
            {tu('available.text', { current: updates.status.current, command: './tix-update.sh' })}
          </span>{' '}
          <a
            href={updateAvailable.url}
            className={alertLink}
            rel="noopener noreferrer"
            target="_blank"
          >
            {tu('available.link')}
          </a>
        </AlertDescription>
      </Alert>
    ),
  ].filter(Boolean);

  const main = (
    <div className="min-w-0 space-y-6">
      {(finance || eventManager) && <DashboardAttention todos={shell?.todos ?? []} />}
      {live && <LiveDashboard initial={live} canOpenEvents={eventManager} />}
    </div>
  );

  return (
    <>
      <AdminPageHeader
        title={t('overview')}
        description={t('welcome', { name: session.displayName })}
      />
      <div className="space-y-6 p-6">
        {alerts.length > 0 && (
          <div className="space-y-3" data-testid="dashboard-alerts">
            {alerts}
          </div>
        )}
        {showChecklist && setup ? (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            {main}
            <aside className="min-w-0">
              <SetupChecklistCard checklist={setup} canDismiss={superAdmin} compact />
            </aside>
          </div>
        ) : (
          main
        )}
        {(pinnedNewer || updates?.status.status === 'error') && (
          <p className="text-xs text-muted-foreground">
            {pinnedNewer && updates?.status.status === 'ok' ? (
              <>
                {tu('pinned', {
                  channel: updates.status.channel,
                  version: pinnedNewer.version,
                })}{' '}
                <a
                  href={pinnedNewer.url}
                  className="underline"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {tu('available.link')}
                </a>
              </>
            ) : (
              tu('checkFailed')
            )}
          </p>
        )}
      </div>
    </>
  );
}
