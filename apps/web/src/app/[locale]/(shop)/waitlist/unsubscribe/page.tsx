import { DomainError, unsubscribeWaitlistEntry } from '@tix/core';
import { CircleAlert, MailCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Link, redirect } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';
import { AuthCard, searchParam } from '../../account/_components/auth-card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shop.waitlist.unsubscribe');
  return { title: t('title'), robots: { index: false }, referrer: 'no-referrer' };
}

export const dynamic = 'force-dynamic';

/**
 * Removal from the waiting list. A button (POST) instead of acting on the GET request: link
 * scanners of mail providers open every link and must not unsubscribe anybody.
 */
export default async function WaitlistUnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await resolveLocale(params);
  const token = searchParam(await searchParams, 'token') ?? '';
  const t = await getTranslations('shop.waitlist.unsubscribe');

  async function unsubscribe(): Promise<void> {
    'use server';
    let target = 'done';
    try {
      await enforceRateLimit('waitlist-token-ip', await clientIp(), 30, 15 * 60_000);
      await unsubscribeWaitlistEntry(getCore(), token);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      target = err.code === 'RATE_LIMITED' ? 'rateLimited' : 'invalid';
    }
    redirect({
      href: { pathname: '/waitlist/unsubscribe', query: { token, result: target } },
      locale,
    });
  }

  const result = searchParam(await searchParams, 'result');
  if (result === 'done') {
    return (
      <AuthCard title={t('title')}>
        <Alert>
          <MailCheck />
          <AlertDescription>{t('done')}</AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <Link href="/">{t('toShop')}</Link>
        </Button>
      </AuthCard>
    );
  }
  if (result === 'invalid' || result === 'rateLimited' || !token) {
    return (
      <AuthCard title={t('title')}>
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>
            {t(result === 'rateLimited' ? 'rateLimited' : 'invalid')}
          </AlertDescription>
        </Alert>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('title')} description={t('question')}>
      <form action={unsubscribe}>
        <Button type="submit" className="w-full">
          {t('confirm')}
        </Button>
      </form>
    </AuthCard>
  );
}
