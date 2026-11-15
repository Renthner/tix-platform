import { DomainError, confirmWaitlistEntry } from '@tix/core';
import { CircleAlert, MailCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';
import { AuthCard, searchParam } from '../../account/_components/auth-card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shop.waitlist.confirm');
  return { title: t('title'), robots: { index: false }, referrer: 'no-referrer' };
}

export const dynamic = 'force-dynamic';

type Outcome = 'confirmed' | 'alreadyConfirmed' | 'invalid' | 'rateLimited';

async function confirm(token: string): Promise<Outcome> {
  try {
    await enforceRateLimit('waitlist-token-ip', await clientIp(), 30, 15 * 60_000);
    const result = await confirmWaitlistEntry(getCore(), token);
    return result.alreadyConfirmed ? 'alreadyConfirmed' : 'confirmed';
  } catch (err) {
    if (err instanceof DomainError && err.code === 'RATE_LIMITED') return 'rateLimited';
    if (err instanceof DomainError && err.code === 'TOKEN_INVALID') return 'invalid';
    throw err;
  }
}

/** Double opt-in: the link from the confirmation e-mail. Opening it twice is harmless. */
export default async function WaitlistConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await resolveLocale(params);
  const outcome = await confirm(searchParam(await searchParams, 'token') ?? '');
  const t = await getTranslations('shop.waitlist.confirm');
  const ok = outcome === 'confirmed' || outcome === 'alreadyConfirmed';
  return (
    <AuthCard title={t('title')}>
      {ok ? (
        <Alert>
          <MailCheck />
          <AlertDescription>{t(outcome)}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{t(outcome)}</AlertDescription>
        </Alert>
      )}
      <Button asChild className="w-full">
        <Link href="/">{t('toShop')}</Link>
      </Button>
    </AuthCard>
  );
}
