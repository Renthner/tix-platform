import { getSetting, isPasswordResetTokenValid, safeReturnPath } from '@tix/core';
import { CircleAlert } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { ResetPasswordForm } from '../_components/auth-forms';
import { AuthCard, searchParam, withNext } from '../_components/auth-card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account.reset');
  return { title: t('title'), robots: { index: false }, referrer: 'no-referrer' };
}

export default async function ResetPasswordPage({
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
  const core = getCore();
  const [t, valid, settings] = await Promise.all([
    getTranslations('account'),
    isPasswordResetTokenValid(core, token),
    getSetting(core, 'customerAccounts'),
  ]);
  return (
    <AuthCard
      title={t('reset.title')}
      description={valid ? t('reset.description') : undefined}
      footer={
        <p>
          <Link href={withNext('/account/login', next)} className="hover:underline">
            {t('fields.backToLogin')}
          </Link>
        </p>
      }
    >
      {valid ? (
        <ResetPasswordForm token={token} next={next} minLength={settings.passwordMinLength} />
      ) : (
        <>
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{t('errors.TOKEN_INVALID')}</AlertDescription>
          </Alert>
          <Button asChild className="w-full">
            <Link href={withNext('/account/forgot-password', next)}>{t('reset.requestNew')}</Link>
          </Button>
        </>
      )}
    </AuthCard>
  );
}
