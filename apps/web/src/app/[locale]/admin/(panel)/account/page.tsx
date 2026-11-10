import { getTranslations } from 'next-intl/server';
import { AccountContent } from '@/components/admin/account/account-content';
import { PageHeader } from '@/components/admin/form-controls';
import { requireAdmin } from '@/server/auth';

export async function generateMetadata() {
  const t = await getTranslations('adminSecurity.account');
  return { title: t('title') };
}

export default async function AccountPage() {
  const session = await requireAdmin([], { allowTwoFactorSetup: true });
  const t = await getTranslations('adminSecurity.account');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <AccountContent userId={session.userId} setupRequired={session.twoFactorSetupRequired} />
    </>
  );
}
