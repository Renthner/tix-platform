import { getSetting, safeReturnPath } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { getAdminSession, readPendingAdminLogin } from '@/server/auth';
import { getCustomerSession } from '@/server/customer-session';
import { LoginForm } from '../_components/auth-forms';
import { AuthCard, searchParam, withNext } from '../_components/auth-card';

export async function generateMetadata() {
  const t = await getTranslations('account.login');
  return { title: t('title'), robots: { index: false } };
}

export default async function CustomerLoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await resolveLocale(params);
  const next = safeReturnPath(searchParam(await searchParams, 'next'));
  if (await getCustomerSession()) redirect({ href: next ?? '/account', locale });
  if (await getAdminSession()) redirect({ href: next ?? '/', locale });
  const pendingTwoFactor = (await readPendingAdminLogin()) !== null;
  const [t, settings] = await Promise.all([
    getTranslations('account'),
    getSetting(getCore(), 'customerAccounts'),
  ]);
  return (
    <AuthCard
      title={t('login.title')}
      description={t('login.description')}
      footer={
        <>
          <p>
            <Link href={withNext('/account/forgot-password', next)} className="hover:underline">
              {t('login.forgot')}
            </Link>
          </p>
          <p>
            {t('login.noAccount')}{' '}
            <Link
              href={withNext('/account/register', next)}
              className="font-medium text-foreground hover:underline"
            >
              {t('login.register')}
            </Link>
          </p>
        </>
      }
    >
      <LoginForm
        next={next}
        loginLinkEnabled={settings.loginLinkEnabled}
        initialCodeStep={pendingTwoFactor}
      />
    </AuthCard>
  );
}
