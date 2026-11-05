import { getSetting } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import {
  BrandingSettingsForm,
  CheckoutSettingsForm,
  GeneralSettingsForm,
  SeatDisplaySettingsForm,
  SettingsSection,
} from '@/components/admin/settings-forms';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { saveSettingsAction } from '@/server/admin/settings';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.settings');
  return { title: t('title') };
}

const SECTIONS = ['general', 'branding', 'checkout', 'seatDisplay'] as const;

export default async function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  const [t, general, branding, checkout, seatDisplay] = await Promise.all([
    getTranslations('admin.settings'),
    getSetting(core, 'general'),
    getSetting(core, 'branding'),
    getSetting(core, 'checkout'),
    getSetting(core, 'seatDisplay'),
  ]);

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="grid gap-6 p-6 lg:grid-cols-[12rem_1fr]">
        <nav className="hidden lg:block" aria-label={t('sectionsLabel')}>
          <ul className="sticky top-6 space-y-1 text-sm">
            {SECTIONS.map((s) => (
              <li key={s}>
                <a href={`#${s}`} className="block rounded-md px-3 py-1.5 hover:bg-accent">
                  {t(`${s}.title`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-6">
          <SettingsSection
            id="general"
            title={t('general.title')}
            description={t('general.description')}
          >
            <GeneralSettingsForm
              action={saveSettingsAction.bind(null, 'general')}
              initial={general}
            />
          </SettingsSection>
          <SettingsSection
            id="branding"
            title={t('branding.title')}
            description={t('branding.description')}
          >
            <BrandingSettingsForm
              action={saveSettingsAction.bind(null, 'branding')}
              initial={{
                primaryColor: branding.primaryColor,
                accentColor: branding.accentColor,
                imprintUrl: branding.imprintUrl,
                privacyUrl: branding.privacyUrl,
                termsUrl: branding.termsUrl,
                footerText: branding.footerText,
              }}
            />
          </SettingsSection>
          <SettingsSection
            id="checkout"
            title={t('checkout.title')}
            description={t('checkout.description')}
          >
            <CheckoutSettingsForm
              action={saveSettingsAction.bind(null, 'checkout')}
              initial={checkout}
            />
          </SettingsSection>
          <SettingsSection
            id="seatDisplay"
            title={t('seatDisplay.title')}
            description={t('seatDisplay.description')}
          >
            <SeatDisplaySettingsForm
              action={saveSettingsAction.bind(null, 'seatDisplay')}
              initial={seatDisplay}
            />
          </SettingsSection>
        </div>
      </div>
    </>
  );
}
