import { getSystemStats, isMetricsEnabled } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
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
  await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  const [t, stats, metricsEnabled] = await Promise.all([
    getTranslations('system'),
    getSystemStats(core),
    isMetricsEnabled(core).catch(() => false),
  ]);
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="p-4 sm:p-6">
        <SystemMonitor initial={stats} metricsEnabled={metricsEnabled} />
      </div>
    </>
  );
}
