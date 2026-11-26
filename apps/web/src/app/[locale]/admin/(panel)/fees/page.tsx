import { redirect } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';

/** Former URL of the global fees & taxes: now a settings page (which checks the roles). */
export default async function FeesRedirectPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const locale = await resolveLocale(params);
  return redirect({ href: '/admin/settings/fees', locale });
}
