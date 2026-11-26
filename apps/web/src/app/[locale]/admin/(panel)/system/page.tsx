import {
  countAdminPasskeys,
  getLoadTestStatus,
  getSystemStats,
  isMetricsEnabled,
  listAlertHistory,
  passkeysAvailable,
  reapExpiredLoadTest,
} from '@tix/core';
import { Gauge } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminPageHeader } from '@/components/admin/page-header';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { AlertHistory } from '@/components/admin/system/alert-history';
import { LoadTestCard } from '@/components/admin/system/load-test-card';
import { SystemMonitor } from '@/components/admin/system/system-monitor';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { allowedSettingsTabs } from '@/lib/settings-tabs';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('system');
  return { title: t('title') };
}

export default async function SystemPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const session = await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  // Closes a run whose time is up (exactly-once audit entry) even if no worker is running.
  await reapExpiredLoadTest(core).catch(() => false);
  const [t, stats, metricsEnabled, alerts, loadTest, passkeyCount] = await Promise.all([
    getTranslations('system'),
    getSystemStats(core),
    isMetricsEnabled(core).catch(() => false),
    listAlertHistory(core, 50).catch(() => []),
    getLoadTestStatus(core).catch(() => ({ active: false as const })),
    countAdminPasskeys(core, session.userId).catch(() => 0),
  ]);
  return (
    <>
      <AdminPageHeader
        breadcrumbs={await hubBreadcrumbs('administration')}
        title={t('title')}
        description={t('description')}
        actions={
          allowedSettingsTabs(session.roles).includes('monitoring') ? (
            <Button asChild variant="outline">
              <Link href="/admin/settings/monitoring">
                <Gauge /> {t('monitoringSettings')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-6 p-4 sm:p-6">
        <SystemMonitor initial={stats} metricsEnabled={metricsEnabled} />
        <div className="grid gap-6 xl:grid-cols-2">
          <AlertHistory rows={alerts} />
          <LoadTestCard
            initial={{
              active: loadTest.active,
              expiresAt: 'expiresAt' in loadTest ? loadTest.expiresAt?.toISOString() : undefined,
            }}
            passkeys={passkeyCount > 0 && passkeysAvailable(core)}
          />
        </div>
      </div>
    </>
  );
}
