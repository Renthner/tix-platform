import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';

export async function generateMetadata() {
  const t = await getTranslations('banking');
  return { title: t('title') };
}

/**
 * Banking & Vorkasse center (role FINANCE; SUPER_ADMIN sees everything). Every page renders its
 * own header (breadcrumbs, actions) and the section navigation via `BankingPage`.
 */
export default async function BankingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  return <>{children}</>;
}
