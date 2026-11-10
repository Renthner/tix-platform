import { getTranslations } from 'next-intl/server';
import { SetPasswordPage } from '@/components/admin/auth/set-password-page';
import { resolveLocale } from '@/i18n/locale';

export async function generateMetadata() {
  const t = await getTranslations('adminSecurity.setPassword');
  return { title: t('inviteTitle'), robots: { index: false, follow: false } };
}

export default async function AcceptInvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  await resolveLocale(params);
  const { token } = await searchParams;
  return <SetPasswordPage mode="invite" token={token} />;
}
