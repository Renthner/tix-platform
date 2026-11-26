'use client';

import {
  Archive,
  ArrowLeftRight,
  Armchair,
  Bell,
  Building,
  Cookie,
  FileText,
  Gauge,
  Globe,
  Handshake,
  Hourglass,
  House,
  Landmark,
  LayoutGrid,
  ListOrdered,
  Mail,
  MailOpen,
  Paintbrush,
  Percent,
  ScanLine,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Smartphone,
  SmartphoneNfc,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { PayPalIcon } from '@/components/admin/admin-nav-links';
import { SETTINGS_GROUP_ICONS } from '@/components/admin/settings-group-icons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import type { SettingsGroup, SettingsTab } from '@/lib/settings-tabs';

const ICONS: Record<SettingsTab, LucideIcon> = {
  general: SlidersHorizontal,
  organizer: Building,
  seo: Globe,
  cookies: Cookie,
  appearance: Paintbrush,
  startPage: House,
  shopLayout: LayoutGrid,
  sponsors: Handshake,
  seatDisplay: Armchair,
  checkout: ShoppingCart,
  fees: Percent,
  waitingRoom: Hourglass,
  waitlist: ListOrdered,
  accounts: UserRound,
  selfService: ArrowLeftRight,
  payments: Landmark,
  paypal: PayPalIcon,
  invoicing: FileText,
  email: Mail,
  emailHeader: MailOpen,
  notifications: Bell,
  wallet: Wallet,
  walletApple: Smartphone,
  walletGoogle: SmartphoneNfc,
  scanner: ScanLine,
  security: ShieldCheck,
  privacy: Archive,
  monitoring: Gauge,
};

export type SettingsStatusTone = 'success' | 'warning' | 'neutral';

/** Short state of a settings page shown on its card (computed on the server). */
export interface SettingsStatus {
  label: string;
  tone: SettingsStatusTone;
}

const TONE_CLASS: Record<SettingsStatusTone, string> = {
  success: 'border-success-border bg-success-soft text-success',
  warning: 'border-warning-border bg-warning-soft text-warning',
  neutral: 'bg-muted text-foreground',
};

/**
 * Settings overview: a search box over page names, groups and field labels (`index`) and one card
 * per page, grouped. `groups`, `index` and `statuses` contain only the pages the user may open.
 */
export function SettingsOverview({
  groups,
  index,
  statuses,
}: {
  groups: SettingsGroup[];
  index: Record<string, string[]>;
  statuses: Partial<Record<SettingsTab, SettingsStatus>>;
}) {
  const t = useTranslations('admin.settings');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = (group: SettingsGroup['group'], tab: SettingsTab) =>
    !needle ||
    [t(`tabs.${tab}`), t(`tabInfo.${tab}`), t(`tabs.groups.${group}`), ...(index[tab] ?? [])].some(
      (text) => text.toLowerCase().includes(needle),
    );
  const visible = groups
    .map(({ group, tabs }) => ({ group, tabs: tabs.filter((tab) => matches(group, tab)) }))
    .filter((g) => g.tabs.length > 0);

  return (
    <div className="space-y-8 p-6" data-testid="settings-overview">
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('overview.searchPlaceholder')}
        aria-label={t('tabs.searchLabel')}
        className="max-w-md"
      />
      {visible.length === 0 && (
        <p className="text-sm text-muted-foreground" role="status">
          {t('tabs.searchNone')}
        </p>
      )}
      {visible.map(({ group, tabs }) => {
        const GroupIcon = SETTINGS_GROUP_ICONS[group];
        return (
          <section key={group} aria-labelledby={`settings-group-${group}`}>
            <h2
              id={`settings-group-${group}`}
              className="mb-3 flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              <GroupIcon className="size-3.5 shrink-0" aria-hidden />
              {t(`tabs.groups.${group}`)}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {tabs.map((tab) => {
                const Icon = ICONS[tab];
                const status = statuses[tab];
                return (
                  <li key={tab}>
                    <Link
                      href={`/admin/settings/${tab}`}
                      className="block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Card className="h-full transition-colors hover:bg-accent">
                        <CardContent className="flex items-start gap-3">
                          <span className="rounded-md bg-muted p-2">
                            <Icon className="size-5" aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                              <span className="font-medium">{t(`tabs.${tab}`)}</span>
                              {status && (
                                <Badge
                                  variant="outline"
                                  className={TONE_CLASS[status.tone]}
                                  data-testid={`settings-status-${tab}`}
                                >
                                  {status.label}
                                </Badge>
                              )}
                            </span>
                            <span className="block text-sm text-muted-foreground">
                              {t(`tabInfo.${tab}`)}
                            </span>
                          </span>
                        </CardContent>
                      </Card>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
