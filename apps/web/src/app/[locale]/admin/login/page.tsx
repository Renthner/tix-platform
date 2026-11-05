import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { resolveLocale } from '@/i18n/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { redirect } from '@/i18n/navigation';
import { pickMessages } from '@/i18n/messages';
import { getAdminSession } from '@/server/auth';
import { LoginForm } from './login-form';

export async function generateMetadata() {
  const t = await getTranslations('admin.login');
  return { title: t('title'), robots: { index: false } };
}

export default async function AdminLoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(params);
  if (await getAdminSession()) redirect({ href: '/admin', locale });
  const t = await getTranslations('admin.login');
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <NextIntlClientProvider messages={await pickMessages(['common', 'admin'])}>
            <LoginForm />
          </NextIntlClientProvider>
        </CardContent>
      </Card>
    </main>
  );
}
