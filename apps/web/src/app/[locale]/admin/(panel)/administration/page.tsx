import { getTranslations } from 'next-intl/server';
import { HubPage } from '@/components/admin/hub-page';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';

export async function generateMetadata() {
  const t = await getTranslations('admin.hubs.administration');
  return { title: t('title') };
}

/** Hub "System": users, security, activity log, backups, system status and monitoring. */
export default async function AdministrationHubPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['SUPER_ADMIN']);
  return <HubPage hub="administration" session={session} />;
}
