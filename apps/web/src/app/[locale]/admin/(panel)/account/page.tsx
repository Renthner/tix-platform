import { getTranslations } from 'next-intl/server';
import { AccountContent } from '@/components/admin/account/account-content';
import { AdminPageHeader } from '@/components/admin/page-header';
import { requireAdmin } from '@/server/auth';

export async function generateMetadata() {
  const t = await getTranslations('adminSecurity.account');
  return { title: t('title') };
}

export default async function AccountPage() {
  const session = await requireAdmin([], { allowTwoFactorSetup: true });
  const [t, ta] = await Promise.all([
    getTranslations('adminSecurity.account'),
    getTranslations('system.alerts'),
  ]);
  const setupRequired = session.twoFactorSetupRequired;
  // Jump links to the sections of AccountContent (same ids, same order).
  const sections = [
    { id: 'twoFactor', label: t('twoFactor.title') },
    { id: 'passkeys', label: t('passkeys.title') },
    ...(setupRequired
      ? []
      : [
          { id: 'emailVerify', label: t('emailVerify.title') },
          { id: 'profile', label: t('profile.title') },
          { id: 'alerts', label: ta('account.title') },
          { id: 'password', label: t('password.title') },
        ]),
  ];
  return (
    <>
      <AdminPageHeader title={t('title')} description={t('description')} />
      <div className="lg:flex lg:items-start">
        <div className="min-w-0 flex-1">
          <AccountContent userId={session.userId} setupRequired={setupRequired} />
        </div>
        <nav
          aria-label={t('sectionsLabel')}
          className="hidden px-6 pt-6 lg:sticky lg:top-0 lg:block lg:w-56 lg:shrink-0"
          data-testid="account-sections"
        >
          <p className="mb-2 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase">
            {t('sectionsLabel')}
          </p>
          <ul className="space-y-1 text-sm">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="block rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </>
  );
}
