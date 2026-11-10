import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/admin/form-controls';
import { BankingTabs } from '@/components/admin/banking/banking-ui';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { bankingStats } from '@/server/admin/banking-queries';

export async function generateMetadata() {
  const t = await getTranslations('banking');
  return { title: t('title') };
}

/** Banking & Vorkasse center (role FINANCE; SUPER_ADMIN sees everything). */
export default async function BankingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const [t, stats] = await Promise.all([getTranslations('banking'), bankingStats()]);
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <BankingTabs reviewCount={stats.review} />
      <div className="space-y-6 p-6">{children}</div>
    </>
  );
}
