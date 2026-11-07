import { customerAccountsEnabled } from '@tix/core';
import { NextIntlClientProvider } from 'next-intl';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { resolveLocale } from '@/i18n/locale';
import { pickMessages } from '@/i18n/messages';
import { getCore } from '@/server/core';

/** Customer account area – unavailable (404) while accounts are disabled in the admin. */
export default async function AccountLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  if (!(await customerAccountsEnabled(getCore()))) notFound();
  return (
    <NextIntlClientProvider messages={await pickMessages(['common', 'account'])}>
      {children}
    </NextIntlClientProvider>
  );
}
