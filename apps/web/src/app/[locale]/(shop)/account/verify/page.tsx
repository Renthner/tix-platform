import { DomainError, safeReturnPath, verifyCustomerEmail } from '@tix/core';
import { CircleAlert, MailCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { getCustomerSession, readCustomerSessionToken } from '@/server/customer-session';
import { clientIp, enforceRateLimit } from '@/server/http';
import { AuthCard, searchParam, withNext } from '../_components/auth-card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account.verify');
  return { title: t('title'), robots: { index: false }, referrer: 'no-referrer' };
}

type Outcome =
  'verified' | 'verifiedNoPassword' | 'alreadyVerified' | 'TOKEN_INVALID' | 'RATE_LIMITED';

/** Consumes the e-mail verification token (`?token=`). Opening it twice is harmless. */
async function verify(token: string): Promise<Outcome> {
  try {
    await enforceRateLimit('customer-token-ip', await clientIp(), 30, 15 * 60_000);
    const result = await verifyCustomerEmail(getCore(), token, {
      sessionToken: await readCustomerSessionToken(),
    });
    if (result.alreadyVerified) return 'alreadyVerified';
    return result.passwordCleared ? 'verifiedNoPassword' : 'verified';
  } catch (err) {
    if (err instanceof DomainError && err.code === 'RATE_LIMITED') return 'RATE_LIMITED';
    if (err instanceof DomainError && err.code === 'TOKEN_INVALID') return 'TOKEN_INVALID';
    throw err;
  }
}

export default async function VerifyEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await resolveLocale(params);
  const query = await searchParams;
  const next = safeReturnPath(searchParam(query, 'next'));
  const outcome = await verify(searchParam(query, 'token') ?? '');
  // After verifying, the session (if any) sees the new state.
  const [t, session] = await Promise.all([getTranslations('account'), getCustomerSession()]);
  const ok =
    outcome === 'verified' || outcome === 'verifiedNoPassword' || outcome === 'alreadyVerified';
  const target = session ? (next ?? '/account') : withNext('/account/login', next ?? '/account');
  return (
    <AuthCard title={t('verify.title')}>
      {ok ? (
        <Alert>
          <MailCheck />
          <AlertDescription>{t(`verify.${outcome}`)}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>
            {outcome === 'RATE_LIMITED' ? t('errors.RATE_LIMITED') : t('verify.invalid')}
          </AlertDescription>
        </Alert>
      )}
      <Button asChild className="w-full">
        <Link href={target}>{session ? t('verify.continue') : t('verify.signIn')}</Link>
      </Button>
    </AuthCard>
  );
}
