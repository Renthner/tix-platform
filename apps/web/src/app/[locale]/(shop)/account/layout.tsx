import { customerAccountsEnabled } from '@tix/core';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { resolveLocale } from '@/i18n/locale';
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
  return <>{children}</>;
}
