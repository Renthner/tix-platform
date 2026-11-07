import { redirect } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';

/** The settings start with the first tab. */
export default async function SettingsIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const locale = await resolveLocale(params);
  await requireAdmin(['SUPER_ADMIN']);
  return redirect({ href: '/admin/settings/general', locale });
}
