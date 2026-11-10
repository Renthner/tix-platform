import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from '@/components/admin/auth/password-link-forms';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { pickMessages } from '@/i18n/messages';
import { forgotPasswordAction } from '../password-actions';

export async function generateMetadata() {
  const t = await getTranslations('adminSecurity.forgot');
  return { title: t('title'), robots: { index: false } };
}

export default async function ForgotPasswordPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  const t = await getTranslations('adminSecurity.forgot');
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <NextIntlClientProvider
            messages={await pickMessages(['common', 'admin', 'adminSecurity'])}
          >
            <ForgotPasswordForm action={forgotPasswordAction} />
          </NextIntlClientProvider>
        </CardContent>
      </Card>
    </main>
  );
}
