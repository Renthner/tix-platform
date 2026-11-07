import { getSetting, hasSecretSetting } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  BankTransferSettingsForm,
  CustomerAccountsSettingsForm,
  InvoicingSettingsForm,
  OrganizerSettingsForm,
  PaypalSettingsForm,
  SmtpSettingsForm,
  SmtpTestForm,
} from '@/components/admin/commerce-settings-forms';
import { PageHeader } from '@/components/admin/form-controls';
import {
  BrandingSettingsForm,
  CheckoutSettingsForm,
  GeneralSettingsForm,
  SeatDisplaySettingsForm,
  SettingsSection,
} from '@/components/admin/settings-forms';
import { SettingsTabs } from '@/components/admin/settings-tabs';
import { resolveLocale } from '@/i18n/locale';
import { SETTINGS_TABS, type SettingsTab } from '@/lib/settings-tabs';
import { requireAdmin } from '@/server/auth';
import { saveSettingsAction, sendTestEmailAction } from '@/server/admin/settings';
import { getCore } from '@/server/core';
import { getEnv } from '@/server/env';

export async function generateMetadata({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const t = await getTranslations('admin.settings');
  const label = (SETTINGS_TABS as readonly string[]).includes(tab)
    ? t(`tabs.${tab as SettingsTab}`)
    : null;
  return { title: label ? `${label} · ${t('title')}` : t('title') };
}

export default async function SettingsTabPage({
  params,
}: {
  params: Promise<{ locale: string; tab: string }>;
}) {
  const locale = await resolveLocale(params);
  const session = await requireAdmin(['SUPER_ADMIN']);
  const { tab } = await params;
  if (!(SETTINGS_TABS as readonly string[]).includes(tab)) notFound();
  const t = await getTranslations('admin.settings');

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <SettingsTabs />
      <div className="max-w-5xl space-y-6 p-6">
        <TabContent tab={tab as SettingsTab} locale={locale} adminEmail={session.email} />
      </div>
    </>
  );
}

async function TabContent({
  tab,
  locale,
  adminEmail,
}: {
  tab: SettingsTab;
  locale: string;
  adminEmail: string;
}) {
  const core = getCore();
  const t = await getTranslations('admin.settings');
  const section = (
    id: 'general' | 'branding' | 'organizer' | 'checkout' | 'seatDisplay' | 'bankTransfer',
    children: React.ReactNode,
  ) => (
    <SettingsSection id={id} title={t(`${id}.title`)} description={t(`${id}.description`)}>
      {children}
    </SettingsSection>
  );

  switch (tab) {
    case 'general':
      return section(
        'general',
        <GeneralSettingsForm
          action={saveSettingsAction.bind(null, 'general')}
          initial={await getSetting(core, 'general')}
        />,
      );
    case 'appearance': {
      const [branding, seatDisplay] = await Promise.all([
        getSetting(core, 'branding'),
        getSetting(core, 'seatDisplay'),
      ]);
      return (
        <>
          {section(
            'branding',
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
            />,
          )}
          {section(
            'seatDisplay',
            <SeatDisplaySettingsForm
              action={saveSettingsAction.bind(null, 'seatDisplay')}
              initial={seatDisplay}
            />,
          )}
        </>
      );
    }
    case 'organizer':
      return section(
        'organizer',
        <OrganizerSettingsForm
          action={saveSettingsAction.bind(null, 'organizer')}
          initial={await getSetting(core, 'organizer')}
        />,
      );
    case 'checkout':
      return section(
        'checkout',
        <CheckoutSettingsForm
          action={saveSettingsAction.bind(null, 'checkout')}
          initial={await getSetting(core, 'checkout')}
        />,
      );
    case 'payments': {
      const [bankTransfer, paypal, secretStored] = await Promise.all([
        getSetting(core, 'bankTransfer'),
        getSetting(core, 'paypal'),
        hasSecretSetting(core, 'paypal.credentials'),
      ]);
      const webhookUrl = `${getEnv().APP_URL.replace(/\/+$/, '')}/api/paypal/webhook`;
      return (
        <>
          {section(
            'bankTransfer',
            <BankTransferSettingsForm
              action={saveSettingsAction.bind(null, 'bankTransfer')}
              initial={bankTransfer}
            />,
          )}
          <SettingsSection
            id="paypal"
            title={t('paypal.title')}
            description={t('paypal.description')}
          >
            <details className="mb-4 rounded-md border bg-muted/40 p-3 text-sm [&[open]>summary]:mb-3">
              <summary className="cursor-pointer font-medium">{t('paypal.guide.title')}</summary>
              <p className="mb-2 text-muted-foreground">{t('paypal.guide.intro')}</p>
              <ol className="list-decimal space-y-2 pl-5">
                {(['account', 'app', 'webhook', 'enable', 'test', 'live'] as const).map((step) => (
                  <li key={step}>
                    {t.rich(`paypal.guide.steps.${step}`, {
                      b: (chunks) => <strong>{chunks}</strong>,
                      link: (chunks) => (
                        <a
                          href="https://developer.paypal.com/dashboard/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          {chunks}
                        </a>
                      ),
                    })}
                  </li>
                ))}
              </ol>
            </details>
            <div className="mb-4 rounded-md bg-muted p-3 text-sm">
              <p>{t('paypal.webhookUrlHint')}</p>
              <code className="mt-1 block font-mono text-xs break-all select-all">
                {webhookUrl}
              </code>
            </div>
            <PaypalSettingsForm
              action={saveSettingsAction.bind(null, 'paypal')}
              initial={paypal}
              secretStored={secretStored}
            />
          </SettingsSection>
        </>
      );
    }
    case 'invoicing':
      return (
        <SettingsSection
          id="invoicing"
          title={t('invoicing.title')}
          description={t('invoicing.description')}
        >
          <InvoicingSettingsForm
            action={saveSettingsAction.bind(null, 'invoicing')}
            initial={await getSetting(core, 'invoicing')}
          />
        </SettingsSection>
      );
    case 'email': {
      const [smtp, passwordStored] = await Promise.all([
        getSetting(core, 'smtp'),
        hasSecretSetting(core, 'smtp.credentials'),
      ]);
      return (
        <SettingsSection id="smtp" title={t('smtp.title')} description={t('smtp.description')}>
          <SmtpSettingsForm
            action={saveSettingsAction.bind(null, 'smtp')}
            initial={smtp}
            passwordStored={passwordStored}
          />
          <SmtpTestForm
            action={sendTestEmailAction}
            defaultRecipient={adminEmail}
            defaultLocale={locale}
          />
        </SettingsSection>
      );
    }
    case 'accounts':
      return (
        <SettingsSection
          id="customerAccounts"
          title={t('customerAccounts.title')}
          description={t('customerAccounts.description')}
        >
          <CustomerAccountsSettingsForm
            action={saveSettingsAction.bind(null, 'customerAccounts')}
            initial={await getSetting(core, 'customerAccounts')}
          />
        </SettingsSection>
      );
  }
}
