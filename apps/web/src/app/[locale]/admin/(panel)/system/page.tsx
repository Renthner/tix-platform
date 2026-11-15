import {
  countAdminPasskeys,
  getLoadTestStatus,
  getSystemStats,
  isMetricsEnabled,
  listAlertHistory,
  passkeysAvailable,
  reapExpiredLoadTest,
} from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import { AlertHistory } from '@/components/admin/system/alert-history';
import { LoadTestCard } from '@/components/admin/system/load-test-card';
import { SystemMonitor } from '@/components/admin/system/system-monitor';
import { resolveLocale } from '@/i18n/locale';
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
      <PageHeader title={t('title')} description={t('description')} />
      <div className="p-4 sm:p-6">
        <SystemMonitor initial={stats} metricsEnabled={metricsEnabled} />
        <div className="mt-6">
          <AlertHistory rows={alerts} />
        </div>
        <div className="mt-6">
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
