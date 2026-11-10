import { isAdminEmailVerificationValid } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { Link } from '@/i18n/navigation';
import { getCore } from '@/server/core';
import { confirmAdminEmailAction } from './actions';

export async function generateMetadata() {
  const t = await getTranslations('adminSecurity.verifyEmail');
  return { title: t('title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/** Landing page of the admin e-mail verification link: the button press consumes the token. */
export default async function VerifyAdminEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string; status?: string }>;
}) {
  await resolveLocale(params);
  const { token, status } = await searchParams;
  const t = await getTranslations('adminSecurity.verifyEmail');
  const done = status === 'done';
  const valid = !done && (await isAdminEmailVerificationValid(getCore(), token));
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {valid && token ? (
            <form action={confirmAdminEmailAction} className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('intro')}</p>
              <input type="hidden" name="token" value={token} />
              <Button type="submit" className="w-full">
                {t('confirm')}
              </Button>
            </form>
          ) : (
            <Alert variant={done ? 'default' : 'destructive'}>
              <AlertDescription>{done ? t('done') : t('invalid')}</AlertDescription>
            </Alert>
          )}
          <Link href="/admin/login" className="text-sm underline">
            {t('backToLogin')}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
