import { getSetting, safeReturnPath } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { getCustomerSession } from '@/server/customer-session';
import { RegisterForm } from '../_components/auth-forms';
import { AuthCard, searchParam, withNext } from '../_components/auth-card';

export async function generateMetadata() {
  const t = await getTranslations('account.register');
  return { title: t('title'), robots: { index: false } };
}

export default async function CustomerRegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await resolveLocale(params);
  const next = safeReturnPath(searchParam(await searchParams, 'next'));
  if (await getCustomerSession()) redirect({ href: next ?? '/account', locale });
  const [t, settings] = await Promise.all([
    getTranslations('account'),
    getSetting(getCore(), 'customerAccounts'),
  ]);
  return (
    <AuthCard
      title={t('register.title')}
      description={t('register.description')}
      footer={
        <p>
          {t('register.haveAccount')}{' '}
          <Link
            href={withNext('/account/login', next)}
            className="font-medium text-foreground hover:underline"
          >
            {t('register.login')}
          </Link>
        </p>
      }
    >
      <RegisterForm next={next} minLength={settings.passwordMinLength} />
      <p className="text-xs text-muted-foreground">{t('register.guestNote')}</p>
    </AuthCard>
  );
}
