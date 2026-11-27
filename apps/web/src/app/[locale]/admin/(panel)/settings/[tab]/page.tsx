import {
  getMediaAsset,
  getSecretSetting,
  listGlobalFees,
  listTaxRatesWithUsage,
  getSetting,
  hasSecretSetting,
  isMetricsEnabled,
  isNonPublicAddress,
} from '@tix/core';
import { EMAIL_LOGO_MIMES, isPublicMediaKind } from '@tix/shared';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  BankTransferSettingsForm,
  CustomerAccountsSettingsForm,
  TicketSelfServiceSettingsForm,
  InvoicingSettingsForm,
  OrganizerSettingsForm,
  PaypalSettingsForm,
  PaypalTestForm,
  SmtpSettingsForm,
  SmtpTestForm,
  WaitlistSettingsForm,
} from '@/components/admin/commerce-settings-forms';
import { EmailHeaderSettingsForm } from '@/components/admin/email-header-form';
import { FeesAdmin } from '@/components/admin/fees-manager';
import {
  GlobalLocaleSwitcher,
  GlobalTranslationPane,
} from '@/components/admin/global-translation-pane';
import { AdminPageHeader } from '@/components/admin/page-header';
import { PrivacySettingsForm } from '@/components/admin/customers/customer-forms';
import { Button } from '@/components/ui/button';
import { BrandingSettingsForm, SponsorsSettingsForm } from '@/components/admin/branding-forms';
import {
  CheckoutSettingsForm,
  CookieNoticeSettingsForm,
  GeneralSettingsForm,
  SeatDisplaySettingsForm,
  SeoSettingsForm,
  ShopLayoutSettingsForm,
  StartPageSettingsForm,
  SettingsSection,
} from '@/components/admin/settings-forms';
import {
  AlertSettingsForm,
  ScannerSettingsForm,
  SecuritySettingsForm,
} from '@/components/admin/security-settings-forms';
import { QueueConfigForm } from '@/components/admin/queue-forms';
import { SettingsTabs } from '@/components/admin/settings-tabs';
import { MetricsTokenCard } from '@/components/admin/system/metrics-token-card';
import {
  AppleWalletForm,
  GoogleWalletForm,
  WalletCheck,
  WalletDesignForm,
} from '@/components/admin/wallet-settings-forms';
import { Card, CardContent } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import {
  allowedSettingsTabs,
  isSettingsTab,
  parseOpenSettingsGroups,
  SETTINGS_GROUPS_COOKIE,
  SETTINGS_TAB_GROUPS,
  SETTINGS_TAB_ROLES,
  settingsGroupsFor,
  type SettingsTab,
} from '@/lib/settings-tabs';
import { hasRole, requireAdmin, type AdminSession } from '@/server/auth';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { getEditLocale } from '@/server/admin/edit-locale';
import {
  deleteGlobalFeeAction,
  deleteTaxRateAction,
  reorderGlobalFeesAction,
  saveGlobalFeeAction,
  saveTaxRateAction,
  setGlobalFeeActiveAction,
} from '@/server/admin/fees';
import { saveQueueConfigAction } from '@/server/admin/queue';
import { queueFormValues } from '@/server/admin/queue-defaults';
import { canEditServerCapacity } from '@/lib/queue-capacity';
import {
  saveSettingsAction,
  sendTestEmailAction,
  testPayPalConnectionAction,
} from '@/server/admin/settings';
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
import { buildSettingsSearchIndex } from '@/server/admin/settings-search';
import { getEnv } from '@/server/env';
import { clientIp } from '@/server/http';
import { descriptionToHtml } from '@/server/rich-text';

export async function generateMetadata({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const t = await getTranslations('admin.settings');
  return { title: isSettingsTab(tab) ? `${t(`tabs.${tab}`)} · ${t('title')}` : t('title') };
}

/** Header actions per page (translation switcher of the pages with translatable texts). */
const TAB_ACTIONS: Partial<Record<SettingsTab, React.ReactNode>> = {
  fees: <GlobalLocaleSwitcher scope="globalFees" />,
  waitingRoom: <GlobalLocaleSwitcher scope="globalQueue" />,
};

export default async function SettingsTabPage({
  params,
}: {
  params: Promise<{ locale: string; tab: string }>;
}) {
  const locale = await resolveLocale(params);
  const { tab } = await params;
  if (!isSettingsTab(tab)) notFound();
  const session = await requireAdmin(SETTINGS_TAB_ROLES[tab]);
  const t = await getTranslations('admin.settings');
  const tabs = allowedSettingsTabs(session.roles);
  // Menu groups expanded in this browser; visiting a page adds its group (the client menu saves
  // it), so the first paint already shows the current group open.
  const saved = parseOpenSettingsGroups((await cookies()).get(SETTINGS_GROUPS_COOKIE)?.value);
  const activeGroup = SETTINGS_TAB_GROUPS.find((g) =>
    (g.tabs as readonly SettingsTab[]).includes(tab),
  )?.group;
  const initialOpen = activeGroup && !saved.includes(activeGroup) ? [...saved, activeGroup] : saved;

  // md+: fixed header, menu and content scroll independently (the admin layout makes `<main>`
  // viewport-high for pages marked `data-admin-panes`). Phones: normal window scrolling.
  return (
    <div data-admin-panes className="md:flex md:min-h-0 md:flex-1 md:flex-col">
      <div className="shrink-0">
        <AdminPageHeader
          breadcrumbs={await hubBreadcrumbs('settings')}
          title={t(`tabs.${tab}`)}
          description={t(`tabInfo.${tab}`)}
          actions={TAB_ACTIONS[tab]}
        />
      </div>
      <div className="flex flex-col gap-6 p-6 md:min-h-0 md:flex-1 md:flex-row md:gap-0 md:p-0">
        <SettingsTabs
          groups={settingsGroupsFor(session.roles)}
          index={await buildSettingsSearchIndex(tabs)}
          initialOpen={initialOpen}
        />
        <div
          key={tab}
          data-testid="settings-content-pane"
          // `relative`: absolutely positioned helpers (hidden checkbox/switch inputs, sr-only text)
          // must be contained by the scrolling pane, otherwise they stretch the document.
          className="min-w-0 md:relative md:min-h-0 md:flex-1 md:overflow-y-auto md:py-6 md:pr-6 md:pl-4"
        >
          {/* Fees & taxes are wide tables: full width; forms stay readable at max-w-4xl. */}
          <div className={cn('space-y-6', tab !== 'fees' && 'max-w-4xl')}>
            <TabContent tab={tab} locale={locale} session={session} />
          </div>
        </div>
      </div>
    </div>
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
  session,
}: {
  tab: SettingsTab;
  locale: string;
  session: AdminSession;
}) {
  const core = getCore();
  const t = await getTranslations('admin.settings');
  const ts = await getTranslations('adminSecurity');
  const section = (
    id:
      | 'general'
      | 'branding'
      | 'sponsors'
      | 'organizer'
      | 'checkout'
      | 'seatDisplay'
      | 'shopLayout'
      | 'startPage'
      | 'seo'
      | 'cookieNotice'
      | 'waitlist'
      | 'bankTransfer',
    children: React.ReactNode,
  ) => (
    // Every page built with this helper has exactly this one section: the page header names it.
    <SettingsSection id={id} title={t(`${id}.title`)} hideHeading>
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
    case 'appearance':
    case 'startPage':
    case 'shopLayout':
    case 'sponsors':
    case 'seatDisplay':
    case 'cookies': {
      const [branding, seatDisplay, shopLayout, startPage, general, cookieNotice, sponsors] =
        await Promise.all([
          getSetting(core, 'branding'),
          getSetting(core, 'seatDisplay'),
          getSetting(core, 'shopLayout'),
          getSetting(core, 'startPage'),
          getSetting(core, 'general'),
          getSetting(core, 'cookieNotice'),
          getSetting(core, 'sponsors'),
        ]);
      const startPageTexts = Object.fromEntries(
        Object.entries(startPage.texts).map(([loc, v]) => [
          loc,
          { ...v, body: descriptionToHtml(v?.body) },
        ]),
      );
      return (
        <>
          {tab === 'appearance' &&
            section(
              'branding',
              <BrandingSettingsForm
                action={saveSettingsAction.bind(null, 'branding')}
                shopName={general.shopName}
                initial={{
                  logo: await pickerAsset(branding.logoAssetId),
                  favicon: await pickerAsset(branding.faviconAssetId),
                  logoHeight: branding.logoHeight,
                  brandColor: branding.brandColor,
                  brandColorDark: branding.brandColorDark,
                  themeMode: branding.themeMode,
                  defaultTheme: branding.defaultTheme,
                  imprintUrl: branding.imprintUrl,
                  privacyUrl: branding.privacyUrl,
                  termsUrl: branding.termsUrl,
                  footerText: descriptionToHtml(branding.footerText),
                }}
              />,
            )}
          {tab === 'sponsors' &&
            section(
              'sponsors',
              <SponsorsSettingsForm
                action={saveSettingsAction.bind(null, 'sponsors')}
                initial={{
                  enabled: sponsors.enabled,
                  height: sponsors.height,
                  label: sponsors.label as Record<string, string>,
                  defaultLocale: general.defaultLocale,
                  items: await Promise.all(
                    sponsors.items.map(async (s) => ({
                      key: s.id,
                      asset: await pickerAsset(s.assetId),
                      durationSeconds: String(s.durationSeconds),
                      url: s.url ?? '',
                      alt: s.alt as Record<string, string>,
                    })),
                  ),
                }}
              />,
            )}
          {tab === 'seatDisplay' &&
            section(
              'seatDisplay',
              <SeatDisplaySettingsForm
                action={saveSettingsAction.bind(null, 'seatDisplay')}
                initial={seatDisplay}
              />,
            )}
          {tab === 'cookies' &&
            section(
              'cookieNotice',
              <CookieNoticeSettingsForm
                action={saveSettingsAction.bind(null, 'cookieNotice')}
                initial={cookieNotice}
              />,
            )}
          {tab === 'shopLayout' &&
            section(
              'shopLayout',
              <ShopLayoutSettingsForm
                action={saveSettingsAction.bind(null, 'shopLayout')}
                initial={shopLayout}
              />,
            )}
          {tab === 'startPage' &&
            section(
              'startPage',
              <StartPageSettingsForm
                action={saveSettingsAction.bind(null, 'startPage')}
                initial={{
                  mode: startPage.mode,
                  layout: startPage.layout,
                  hero: await pickerAsset(startPage.heroAssetId),
                  gallery: await Promise.all(startPage.galleryAssetIds.map(pickerAsset)),
                  buttonUrl: startPage.buttonUrl,
                  buttonAlign: startPage.buttonAlign,
                  defaultLocale: general.defaultLocale,
                  texts: startPageTexts,
                }}
              />,
            )}
        </>
      );
    }
    case 'seo': {
      const [seo, general] = await Promise.all([
        getSetting(core, 'seo'),
        getSetting(core, 'general'),
      ]);
      return section(
        'seo',
        <SeoSettingsForm
          action={saveSettingsAction.bind(null, 'seo')}
          initial={{
            indexing: seo.indexing,
            titleTemplate: seo.titleTemplate,
            shareImage: await pickerAsset(seo.shareImageAssetId),
            twitterHandle: seo.twitterHandle,
            googleVerification: seo.verification.google,
            bingVerification: seo.verification.bing,
            defaultLocale: general.defaultLocale,
            texts: seo.texts,
            shopName: general.shopName,
          }}
        />,
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
    case 'waitlist': {
      const detectedIp = await clientIp();
      return (
        <>
          {tab === 'checkout' &&
            section(
              'checkout',
              <CheckoutSettingsForm
                action={saveSettingsAction.bind(null, 'checkout')}
                initial={await getSetting(core, 'checkout')}
                detectedIp={detectedIp}
                detectedIpPrivate={detectedIp === '0.0.0.0' || isNonPublicAddress(detectedIp)}
              />,
            )}
          {tab === 'waitlist' &&
            section(
              'waitlist',
              <WaitlistSettingsForm
                action={saveSettingsAction.bind(null, 'waitlist')}
                initial={await getSetting(core, 'waitlist')}
              />,
            )}
        </>
      );
    }
    case 'payments':
    case 'paypal': {
      const [bankTransfer, paypal, secretStored] = await Promise.all([
        getSetting(core, 'bankTransfer'),
        getSetting(core, 'paypal'),
        hasSecretSetting(core, 'paypal.credentials'),
      ]);
      const webhookUrl = `${getEnv().APP_URL.replace(/\/+$/, '')}/api/paypal/webhook`;
      return (
        <>
          {tab === 'payments' &&
            section(
              'bankTransfer',
              <BankTransferSettingsForm
                action={saveSettingsAction.bind(null, 'bankTransfer')}
                initial={bankTransfer}
              />,
            )}
          {tab === 'paypal' && (
            <SettingsSection id="paypal" title={t('paypal.title')} hideHeading>
              <details className="mb-4 rounded-md border bg-muted/40 p-3 text-sm [&[open]>summary]:mb-3">
                <summary className="cursor-pointer font-medium">{t('paypal.guide.title')}</summary>
                <p className="mb-2 text-muted-foreground">{t('paypal.guide.intro')}</p>
                <ol className="list-decimal space-y-2 pl-5">
                  {(['account', 'app', 'webhook', 'enable', 'test', 'live'] as const).map(
                    (step) => (
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
                    ),
                  )}
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
              <PaypalTestForm action={testPayPalConnectionAction} />
            </SettingsSection>
          )}
        </>
      );
    }
    case 'invoicing':
      return (
        <SettingsSection id="invoicing" title={t('invoicing.title')} hideHeading>
          <InvoicingSettingsForm
            action={saveSettingsAction.bind(null, 'invoicing')}
            initial={await getSetting(core, 'invoicing')}
          />
        </SettingsSection>
      );
    case 'email':
    case 'emailHeader': {
      const [smtp, passwordStored, header, branding, general] = await Promise.all([
        getSetting(core, 'smtp'),
        hasSecretSetting(core, 'smtp.credentials'),
        getSetting(core, 'emailHeader'),
        getSetting(core, 'branding'),
        getSetting(core, 'general'),
      ]);
      const shopLogoAsset = branding.logoAssetId
        ? await getMediaAsset(core, branding.logoAssetId)
        : null;
      return (
        <>
          {tab === 'email' && (
            <SettingsSection id="smtp" title={t('smtp.title')} hideHeading>
              <SmtpSettingsForm
                action={saveSettingsAction.bind(null, 'smtp')}
                initial={smtp}
                passwordStored={passwordStored}
              />
              <SmtpTestForm
                action={sendTestEmailAction}
                defaultRecipient={session.email}
                defaultLocale={locale}
              />
            </SettingsSection>
          )}
          {tab === 'emailHeader' && (
            <SettingsSection id="emailHeader" title={t('emailHeader.title')} hideHeading>
              <EmailHeaderSettingsForm
                action={saveSettingsAction.bind(null, 'emailHeader')}
                shopName={general.shopName}
                brandColor={branding.brandColor}
                shopLogo={
                  shopLogoAsset && isPublicMediaKind(shopLogoAsset.kind)
                    ? {
                        id: shopLogoAsset.id,
                        width: shopLogoAsset.width,
                        height: shopLogoAsset.height,
                        supported: EMAIL_LOGO_MIMES.includes(shopLogoAsset.mimeType),
                        shopHeaderHeight: branding.logoHeight,
                      }
                    : null
                }
                initial={{
                  logoDisplay: header.logoDisplay,
                  layout: header.layout,
                  align: header.align,
                  logoHeight: header.logoHeight,
                  chipColor: header.chipColor,
                  chipCorners: header.chipCorners,
                  chipPadding: header.chipPadding,
                  override: await pickerAsset(header.logoAssetId),
                }}
              />
            </SettingsSection>
          )}
        </>
      );
    }
    case 'wallet':
    case 'walletApple':
    case 'walletGoogle': {
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
          {tab === 'wallet' && (
            <SettingsSection id="walletIntro" title={tw('title')} description={tw('description')}>
              <p className="text-sm text-muted-foreground">{tw('optionalNote')}</p>
            </SettingsSection>
          )}
          {tab === 'walletApple' && (
            <SettingsSection id="walletApple" title={tw('apple.title')} hideHeading>
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
          )}
          {tab === 'walletGoogle' && (
            <SettingsSection id="walletGoogle" title={tw('google.title')} hideHeading>
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
          )}
          {tab === 'wallet' && (
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
          )}
        </>
      );
    }
    case 'security':
    case 'monitoring': {
      const tm = await getTranslations('system.security');
      return (
        <>
          {tab === 'security' && (
            <SettingsSection id="security" title={ts('settings.security.title')} hideHeading>
              <SecuritySettingsForm
                action={saveSettingsAction.bind(null, 'security')}
                initial={await getSetting(core, 'security')}
              />
            </SettingsSection>
          )}
          {tab === 'monitoring' && (
            <SettingsSection id="monitoring" title={tm('title')} hideHeading>
              <MetricsTokenCard enabled={await isMetricsEnabled(core)} />
            </SettingsSection>
          )}
        </>
      );
    }
    case 'privacy': {
      const tp = await getTranslations('customers.settings');
      return (
        <SettingsSection id="privacy" title={tp('title')} hideHeading>
          <p className="mb-4 text-sm text-muted-foreground">{tp('description')}</p>
          <PrivacySettingsForm initial={await getSetting(core, 'privacy')} />
        </SettingsSection>
      );
    }
    case 'notifications': {
      const ta = await getTranslations('system.alerts.settings');
      return (
        <SettingsSection id="alerts" title={ta('title')} hideHeading>
          <AlertSettingsForm
            action={saveSettingsAction.bind(null, 'alerts')}
            initial={await getSetting(core, 'alerts')}
          />
        </SettingsSection>
      );
    }
    case 'scanner':
      return (
        <SettingsSection id="scanner" title={ts('settings.scanner.title')} hideHeading>
          <p className="mb-4 rounded-md bg-muted p-3 text-sm">{ts('settings.scanner.phaseNote')}</p>
          <ScannerSettingsForm
            action={saveSettingsAction.bind(null, 'scanner')}
            initial={await getSetting(core, 'scanner')}
          />
        </SettingsSection>
      );
    case 'accounts':
    case 'selfService':
      return (
        <>
          {tab === 'accounts' && (
            <SettingsSection id="customerAccounts" title={t('customerAccounts.title')} hideHeading>
              <CustomerAccountsSettingsForm
                action={saveSettingsAction.bind(null, 'customerAccounts')}
                initial={await getSetting(core, 'customerAccounts')}
              />
            </SettingsSection>
          )}
          {tab === 'selfService' && (
            <SettingsSection
              id="ticketSelfService"
              title={t('ticketSelfService.title')}
              hideHeading
            >
              <TicketSelfServiceSettingsForm
                action={saveSettingsAction.bind(null, 'ticketSelfService')}
                initial={await getSetting(core, 'ticketSelfService')}
              />
            </SettingsSection>
          )}
        </>
      );
    case 'fees': {
      const editLocale = await getEditLocale();
      if (editLocale) return <GlobalTranslationPane scope="globalFees" editLocale={editLocale} />;
      const [general, taxRates, fees] = await Promise.all([
        getSetting(core, 'general'),
        listTaxRatesWithUsage(core.db),
        listGlobalFees(core.db),
      ]);
      return (
        <FeesAdmin
          currency={general.defaultCurrency}
          canEdit={hasRole(session, ['FINANCE'])}
          createTaxRate={saveTaxRateAction.bind(null, null)}
          createFee={saveGlobalFeeAction.bind(null, null)}
          setFeeActive={setGlobalFeeActiveAction}
          reorderFees={reorderGlobalFeesAction}
          taxRates={taxRates.map((r) => ({
            id: r.id,
            name: r.name,
            rateBasisPoints: r.rateBasisPoints,
            invoiceNote: r.invoiceNote,
            isDefault: r.isDefault,
            isActive: r.isActive,
            sortOrder: r.sortOrder,
            eventCount: r.eventCount,
            feeCount: r.feeCount,
            save: saveTaxRateAction.bind(null, r.id),
            remove: deleteTaxRateAction.bind(null, r.id),
          }))}
          fees={fees.map((f) => ({
            id: f.id,
            name: f.name,
            scope: f.scope,
            calculation: f.calculation,
            value: f.value,
            taxRateId: f.taxRateId,
            paymentMethods: f.paymentMethods,
            channels: f.channels,
            isActive: f.isActive,
            sortOrder: f.sortOrder,
            overrideCount: f.overrideCount,
            waivedCount: f.waivedCount,
            save: saveGlobalFeeAction.bind(null, f.id),
            remove: deleteGlobalFeeAction.bind(null, f.id),
          }))}
        />
      );
    }
    case 'waitingRoom': {
      const editLocale = await getEditLocale();
      if (editLocale) return <GlobalTranslationPane scope="globalQueue" editLocale={editLocale} />;
      const form = await queueFormValues(null);
      return (
        <Card>
          <CardContent>
            <QueueConfigForm
              action={saveQueueConfigAction.bind(null, null)}
              initial={form.values}
              scope="global"
              canEditServerCapacity={canEditServerCapacity(session.roles)}
            />
          </CardContent>
        </Card>
      );
    }
  }
}
