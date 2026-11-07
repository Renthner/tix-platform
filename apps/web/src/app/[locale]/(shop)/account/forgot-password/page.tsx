import { safeReturnPath } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { ForgotPasswordForm } from '../_components/auth-forms';
import { AuthCard, searchParam, withNext } from '../_components/auth-card';

export async function generateMetadata() {
  const t = await getTranslations('account.forgot');
  return { title: t('title'), robots: { index: false } };
}

export default async function ForgotPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await resolveLocale(params);
  const next = safeReturnPath(searchParam(await searchParams, 'next'));
  const t = await getTranslations('account');
  return (
    <AuthCard
      title={t('forgot.title')}
      description={t('forgot.description')}
      footer={
        <p>
          <Link href={withNext('/account/login', next)} className="hover:underline">
            {t('fields.backToLogin')}
          </Link>
        </p>
      }
    >
      <ForgotPasswordForm next={next} />
    </AuthCard>
  );
}
