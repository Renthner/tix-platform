import { getSetting, isMetricsEnabled } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminPageHeader } from '@/components/admin/page-header';
import {
  SettingsOverview,
  type SettingsStatus,
  type SettingsStatusTone,
} from '@/components/admin/settings-overview';
import { resolveLocale } from '@/i18n/locale';
import {
  allowedSettingsTabs,
  SETTINGS_ROLES,
  settingsGroupsFor,
  type SettingsTab,
} from '@/lib/settings-tabs';
import { requireAdmin } from '@/server/auth';
import { queueFormValues } from '@/server/admin/queue-defaults';
import { buildSettingsSearchIndex } from '@/server/admin/settings-search';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.settings');
  return { title: t('title') };
}

type StatusKey =
  | 'configured'
  | 'notSetUp'
  | 'on'
  | 'off'
  | 'live'
  | 'sandbox'
  | 'indexed'
  | 'notIndexed'
  | 'twoFactorRequired'
  | 'twoFactorSuperAdmins'
  | 'twoFactorOptional'
  | 'customAddress'
  | 'shopAddress';

/**
 * Card badges of the overview, read from the settings. Each one is independent: a failing read
 * only drops its badge.
 */
async function loadStatuses(
  tabs: readonly SettingsTab[],
): Promise<Partial<Record<SettingsTab, SettingsStatus>>> {
  const core = getCore();
  const [t, tq] = await Promise.all([
    getTranslations('admin.settings.overview.status'),
    getTranslations('admin.queue.modes'),
  ]);
  const s = (key: StatusKey, tone: SettingsStatusTone): SettingsStatus => ({
    label: t(key),
    tone,
  });
  const onOff = (enabled: boolean) => (enabled ? s('on', 'success') : s('off', 'neutral'));
  const readers: Partial<Record<SettingsTab, () => Promise<SettingsStatus>>> = {
    email: async () =>
      (await getSetting(core, 'smtp')).host ? s('configured', 'success') : s('notSetUp', 'warning'),
    paypal: async () => {
      const paypal = await getSetting(core, 'paypal');
      if (!paypal.enabled) return s('off', 'neutral');
      return paypal.environment === 'live' ? s('live', 'success') : s('sandbox', 'warning');
    },
    payments: async () => onOff((await getSetting(core, 'bankTransfer')).enabled),
    walletApple: async () => onOff((await getSetting(core, 'wallet.apple')).enabled),
    walletGoogle: async () => onOff((await getSetting(core, 'wallet.google')).enabled),
    scanner: async () =>
      (await getSetting(core, 'scanner')).serverUrl
        ? s('customAddress', 'neutral')
        : s('shopAddress', 'neutral'),
    seo: async () =>
      (await getSetting(core, 'seo')).indexing
        ? s('indexed', 'success')
        : s('notIndexed', 'warning'),
    cookies: async () => onOff((await getSetting(core, 'cookieNotice')).enabled),
    accounts: async () => onOff((await getSetting(core, 'customerAccounts')).enabled),
    selfService: async () => onOff((await getSetting(core, 'ticketSelfService')).enabled),
    waitlist: async () => onOff((await getSetting(core, 'waitlist')).enabled),
    security: async () => {
      const security = await getSetting(core, 'security');
      if (security.requireTwoFactor) return s('twoFactorRequired', 'success');
      if (security.requireTwoFactorForSuperAdmins) return s('twoFactorSuperAdmins', 'success');
      return s('twoFactorOptional', 'neutral');
    },
    monitoring: async () => onOff(await isMetricsEnabled(core)),
    waitingRoom: async () => {
      const { mode } = (await queueFormValues(null)).values;
      return mode === 'OFF' ? s('off', 'neutral') : { label: tq(`${mode}.label`), tone: 'success' };
    },
  };
  const entries = tabs.flatMap((tab) => {
    const read = readers[tab];
    return read ? [[tab, read] as const] : [];
  });
  const results = await Promise.allSettled(entries.map(([, read]) => read()));
  const statuses: Partial<Record<SettingsTab, SettingsStatus>> = {};
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') statuses[entries[i]![0]] = result.value;
  });
  return statuses;
}

/** Settings overview: every settings page the user may open, grouped, with a short state. */
export default async function SettingsOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(SETTINGS_ROLES);
  const tabs = allowedSettingsTabs(session.roles);
  if (tabs.length === 0) notFound();
  const [t, index, statuses] = await Promise.all([
    getTranslations('admin.settings'),
    buildSettingsSearchIndex(tabs),
    loadStatuses(tabs),
  ]);
  return (
    <>
      <AdminPageHeader title={t('title')} description={t('overview.description')} />
      <SettingsOverview
        groups={settingsGroupsFor(session.roles)}
        index={index}
        statuses={statuses}
      />
    </>
  );
}
