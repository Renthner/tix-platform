import { getMediaAsset, getSecretSetting, getSetting, hasSecretSetting } from '@tix/core';
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
import { Button } from '@/components/ui/button';
import {
  BrandingSettingsForm,
  CheckoutSettingsForm,
  GeneralSettingsForm,
  SeatDisplaySettingsForm,
  SettingsSection,
} from '@/components/admin/settings-forms';
import {
  ScannerSettingsForm,
  SecuritySettingsForm,
} from '@/components/admin/security-settings-forms';
import { SettingsTabs } from '@/components/admin/settings-tabs';
import {
  AppleWalletForm,
  GoogleWalletForm,
  WalletCheck,
  WalletDesignForm,
} from '@/components/admin/wallet-settings-forms';
import { resolveLocale } from '@/i18n/locale';
import { SETTINGS_TABS, type SettingsTab } from '@/lib/settings-tabs';
import { requireAdmin } from '@/server/auth';
import { saveSettingsAction, sendTestEmailAction } from '@/server/admin/settings';
import { restoreSetupChecklistAction } from '@/server/admin/setup-checklist';
import {
  checkAppleWalletAction,
  checkGoogleWalletAction,
  saveAppleWalletAction,
  saveGoogleWalletAction,
  saveWalletDesignAction,
} from '@/server/admin/wallet';
import { loadWalletDesignValues } from '@/server/admin/wallet-design';
import { getCore } from '@/server/core';
import { getEnv } from '@/server/env';
import { descriptionToHtml } from '@/server/rich-text';

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

async function pickerAsset(id: string | undefined) {
  if (!id) return null;
  const row = await getMediaAsset(getCore(), id);
  return row ? { id: row.id, fileName: row.fileName, width: row.width, height: row.height } : null;
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
  const ts = await getTranslations('adminSecurity');
  const section = (
    id: 'general' | 'branding' | 'organizer' | 'checkout' | 'seatDisplay' | 'bankTransfer',
    children: React.ReactNode,
  ) => (
    <SettingsSection id={id} title={t(`${id}.title`)} description={t(`${id}.description`)}>
      {children}
    </SettingsSection>
  );

  switch (tab) {
    case 'general': {
      const checklistDismissed = (await getSetting(core, 'setupChecklist')).dismissed;
      return (
        <>
          {section(
            'general',
            <GeneralSettingsForm
              action={saveSettingsAction.bind(null, 'general')}
              initial={await getSetting(core, 'general')}
            />,
          )}
          {checklistDismissed && (
            <form
              action={restoreSetupChecklistAction}
              className="flex items-center justify-between gap-4 rounded-lg border p-4"
            >
              <p className="text-sm text-muted-foreground">{t('general.setupChecklistHint')}</p>
              <Button type="submit" variant="outline" size="sm">
                {t('general.setupChecklistShow')}
              </Button>
            </form>
          )}
        </>
      );
    }
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
                logo: await pickerAsset(branding.logoAssetId),
                favicon: await pickerAsset(branding.faviconAssetId),
                primaryColor: branding.primaryColor,
                accentColor: branding.accentColor,
                imprintUrl: branding.imprintUrl,
                privacyUrl: branding.privacyUrl,
                termsUrl: branding.termsUrl,
                footerText: descriptionToHtml(branding.footerText),
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
    case 'wallet': {
      const [apple, google, certsStored, credsStored, design, tw] = await Promise.all([
        getSetting(core, 'wallet.apple'),
        getSetting(core, 'wallet.google'),
        hasSecretSetting(core, 'wallet.apple.certificates'),
        hasSecretSetting(core, 'wallet.google.credentials'),
        loadWalletDesignValues(null),
        getTranslations('admin.wallet'),
      ]);
      const applePassphraseStored = certsStored
        ? Boolean(
            (await getSecretSetting(core, 'wallet.apple.certificates').catch(() => null))
              ?.signerKeyPassphrase,
          )
        : false;
      const rich = {
        b: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
        code: (chunks: React.ReactNode) => <code className="font-mono text-xs">{chunks}</code>,
      };
      const guide = (kind: 'apple' | 'google', steps: readonly string[], href: string) => (
        <details className="mb-4 rounded-md border bg-muted/40 p-3 text-sm [&[open]>summary]:mb-3">
          <summary className="cursor-pointer font-medium">{tw(`${kind}.guide.title`)}</summary>
          <p className="mb-2 text-muted-foreground">{tw(`${kind}.guide.intro`)}</p>
          <ol className="list-decimal space-y-2 pl-5">
            {steps.map((step) => (
              <li key={step}>
                {tw.rich(`${kind}.guide.steps.${step}` as 'apple.guide.steps.account', {
                  ...rich,
                  link: (chunks) => (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
                      {chunks}
                    </a>
                  ),
                })}
              </li>
            ))}
          </ol>
        </details>
      );
      return (
        <>
          <SettingsSection id="walletIntro" title={tw('title')} description={tw('description')}>
            <p className="text-sm text-muted-foreground">{tw('optionalNote')}</p>
          </SettingsSection>
          <SettingsSection
            id="walletApple"
            title={tw('apple.title')}
            description={tw('apple.description')}
          >
            {guide(
              'apple',
              ['account', 'passType', 'certificate', 'export', 'wwdr', 'upload', 'test'],
              'https://developer.apple.com/account/resources/identifiers/list/passTypeId',
            )}
            <AppleWalletForm
              action={saveAppleWalletAction}
              initial={apple}
              certificatesStored={certsStored}
              passphraseStored={applePassphraseStored}
            />
            <div className="mt-4">
              <WalletCheck action={checkAppleWalletAction} />
            </div>
          </SettingsSection>
          <SettingsSection
            id="walletGoogle"
            title={tw('google.title')}
            description={tw('google.description')}
          >
            {guide(
              'google',
              ['console', 'issuer', 'project', 'serviceAccount', 'access', 'upload', 'test'],
              'https://pay.google.com/business/console',
            )}
            <GoogleWalletForm
              action={saveGoogleWalletAction}
              initial={google}
              credentialsStored={credsStored}
            />
            <div className="mt-4">
              <WalletCheck action={checkGoogleWalletAction} />
            </div>
          </SettingsSection>
          <SettingsSection
            id="walletDesign"
            title={tw('design.title')}
            description={tw('design.description')}
          >
            <WalletDesignForm
              action={saveWalletDesignAction.bind(null, null)}
              initial={design.values}
              isOverride={design.isOverride}
            />
          </SettingsSection>
        </>
      );
    }
    case 'security':
      return (
        <SettingsSection
          id="security"
          title={ts('settings.security.title')}
          description={ts('settings.security.description')}
        >
          <SecuritySettingsForm
            action={saveSettingsAction.bind(null, 'security')}
            initial={await getSetting(core, 'security')}
          />
        </SettingsSection>
      );
    case 'scanner':
      return (
        <SettingsSection
          id="scanner"
          title={ts('settings.scanner.title')}
          description={ts('settings.scanner.description')}
        >
          <p className="mb-4 rounded-md bg-muted p-3 text-sm">{ts('settings.scanner.phaseNote')}</p>
          <ScannerSettingsForm
            action={saveSettingsAction.bind(null, 'scanner')}
            initial={await getSetting(core, 'scanner')}
          />
        </SettingsSection>
      );
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
