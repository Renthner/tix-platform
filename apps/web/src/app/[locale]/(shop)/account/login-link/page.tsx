import { getSetting, safeReturnPath } from '@tix/core';
import { CircleAlert } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { LoginLinkForm } from '../_components/auth-forms';
import { AuthCard, searchParam, withNext } from '../_components/auth-card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account.loginLink');
  return { title: t('title'), robots: { index: false }, referrer: 'no-referrer' };
}

/**
 * Target of the "sign-in link" e-mail. The token is consumed only by the button press (a
 * server action) – link scanners of mail providers open URLs but do not submit forms.
 */
export default async function LoginLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await resolveLocale(params);
  const query = await searchParams;
  const token = searchParam(query, 'token') ?? '';
  const next = safeReturnPath(searchParam(query, 'next'));
  const [t, settings] = await Promise.all([
    getTranslations('account'),
    getSetting(getCore(), 'customerAccounts'),
  ]);
  const problem = !settings.loginLinkEnabled
    ? t('errors.LOGIN_LINK_DISABLED')
    : !/^[A-Za-z0-9_-]{20,200}$/.test(token)
      ? t('errors.TOKEN_INVALID')
      : null;
  return (
    <AuthCard
      title={t('loginLink.title')}
      description={problem ? undefined : t('loginLink.description')}
      footer={
        <p>
          <Link href={withNext('/account/login', next)} className="hover:underline">
            {t('fields.backToLogin')}
          </Link>
        </p>
      }
    >
      {problem ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : (
        <LoginLinkForm token={token} next={next} />
      )}
    </AuthCard>
  );
}
