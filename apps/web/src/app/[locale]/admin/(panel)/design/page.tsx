import { getTranslations } from 'next-intl/server';
import { HubPage } from '@/components/admin/hub-page';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';

export async function generateMetadata() {
  const t = await getTranslations('admin.hubs.design');
  return { title: t('title') };
}

/** Hub "Design": shop appearance, ticket / e-mail templates and the libraries. */
export default async function DesignHubPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const session = await requireAdmin(['EVENT_MANAGER']);
  return <HubPage hub="design" session={session} />;
}
