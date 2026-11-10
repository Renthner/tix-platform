import { getSetting, isAdminTokenValid } from '@tix/core';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { pickMessages } from '@/i18n/messages';
import { Link } from '@/i18n/navigation';
import { getCore } from '@/server/core';
import { setPasswordAction } from '@/app/[locale]/admin/password-actions';
import { SetPasswordForm } from './password-link-forms';

/** Shared page body of the invitation (`accept-invite`) and password reset links. */
export async function SetPasswordPage({
  mode,
  token,
}: {
  mode: 'invite' | 'reset';
  token: string | undefined;
}) {
  const t = await getTranslations('adminSecurity.setPassword');
  const core = getCore();
  const valid = await isAdminTokenValid(
    core,
    token,
    mode === 'invite' ? 'INVITE' : 'PASSWORD_RESET',
  );
  const { minPasswordLength } = await getSetting(core, 'security');
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t(`${mode}Title`)}</CardTitle>
        </CardHeader>
        <CardContent>
          {valid && token ? (
            <NextIntlClientProvider
              messages={await pickMessages(['common', 'admin', 'adminSecurity'])}
            >
              <SetPasswordForm
                action={setPasswordAction.bind(null, mode, token)}
                mode={mode}
                minLength={minPasswordLength}
              />
            </NextIntlClientProvider>
          ) : (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertDescription>{t('invalidLink')}</AlertDescription>
              </Alert>
              <Link href="/admin/login" className="text-sm underline">
                {t('backToLogin')}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
