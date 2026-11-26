import {
  Activity,
  Archive,
  Armchair,
  DatabaseBackup,
  Gauge,
  Handshake,
  House,
  Images,
  LayoutGrid,
  Mail,
  MailOpen,
  Paintbrush,
  ScrollText,
  Shapes,
  ShieldCheck,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminPageHeader } from '@/components/admin/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { allowedNavKeys } from '@/lib/admin-nav-access';
import type { NavKey } from '@/lib/admin-nav-model';
import { allowedSettingsTabs, type SettingsTab } from '@/lib/settings-tabs';
import type { AdminSession } from '@/server/auth';

/**
 * A hub card; shown when the user may open its target: a navigation key (`access`) or a settings
 * page (`settingsTab`, role rule of SETTINGS_TAB_ROLES).
 */
type HubCard = { id: string; href: string; icon: LucideIcon } & (
  { access: NavKey; settingsTab?: never } | { settingsTab: SettingsTab; access?: never }
);

type HubId = 'design' | 'administration';

/** Cards of the hub pages, in sections (display order). */
const HUBS: Record<HubId, { section: string; cards: HubCard[] }[]> = {
  design: [
    {
      section: 'shop',
      cards: [
        {
          id: 'appearance',
          href: '/admin/settings/appearance',

          settingsTab: 'appearance',

          icon: Paintbrush,
        },
        {
          id: 'startPage',
          href: '/admin/settings/startPage',
          settingsTab: 'startPage',
          icon: House,
        },
        {
          id: 'shopLayout',
          href: '/admin/settings/shopLayout',

          settingsTab: 'shopLayout',

          icon: LayoutGrid,
        },
        {
          id: 'sponsors',
          href: '/admin/settings/sponsors',
          settingsTab: 'sponsors',
          icon: Handshake,
        },
        {
          id: 'seatDisplay',
          href: '/admin/settings/seatDisplay',

          settingsTab: 'seatDisplay',

          icon: Armchair,
        },
      ],
    },
    {
      section: 'documents',
      cards: [
        {
          id: 'ticketTemplates',
          href: '/admin/ticket-templates',
          access: 'ticketTemplates',
          icon: Ticket,
        },
        {
          id: 'emailTemplates',
          href: '/admin/email-templates',
          access: 'emailTemplates',
          icon: Mail,
        },
        {
          id: 'emailHeader',
          href: '/admin/settings/emailHeader',

          settingsTab: 'emailHeader',

          icon: MailOpen,
        },
      ],
    },
    {
      section: 'libraries',
      cards: [
        { id: 'media', href: '/admin/media', access: 'media', icon: Images },
        { id: 'symbols', href: '/admin/symbols', access: 'symbols', icon: Shapes },
      ],
    },
  ],
  administration: [
    {
      section: 'access',
      cards: [
        { id: 'users', href: '/admin/users', access: 'users', icon: Users },
        {
          id: 'security',
          href: '/admin/settings/security',

          settingsTab: 'security',

          icon: ShieldCheck,
        },
        {
          id: 'privacy',
          href: '/admin/settings/privacy',
          settingsTab: 'privacy',
          icon: Archive,
        },
        { id: 'audit', href: '/admin/audit', access: 'audit', icon: ScrollText },
      ],
    },
    {
      section: 'operations',
      cards: [
        { id: 'backups', href: '/admin/backups', access: 'backups', icon: DatabaseBackup },
        { id: 'system', href: '/admin/system', access: 'system', icon: Activity },
        {
          id: 'monitoring',
          href: '/admin/settings/monitoring',

          settingsTab: 'monitoring',

          icon: Gauge,
        },
      ],
    },
  ],
};

/** Hub page: header plus a grid of cards (icon, title, one line) for the pages the user may open. */
export async function HubPage({ hub, session }: { hub: HubId; session: AdminSession }) {
  const tHubs = await getTranslations('admin.hubs');
  // Keys are built from the card table above (admin.hubs.<hub>.…), present in both locales.
  const t = (key: string) => (tHubs as unknown as (k: string) => string)(`${hub}.${key}`);
  const allowed = allowedNavKeys(session.roles);
  const allowedTabs = allowedSettingsTabs(session.roles);
  const visible = (c: HubCard) =>
    c.settingsTab ? allowedTabs.includes(c.settingsTab) : allowed.includes(c.access);
  const sections = HUBS[hub]
    .map((s) => ({ ...s, cards: s.cards.filter(visible) }))
    .filter((s) => s.cards.length > 0);
  return (
    <>
      <AdminPageHeader title={t('title')} description={t('description')} />
      <div className="space-y-8 p-6" data-testid={`hub-${hub}`}>
        {sections.map((section) => (
          <section key={section.section} aria-labelledby={`hub-${hub}-${section.section}`}>
            <h2
              id={`hub-${hub}-${section.section}`}
              className="mb-3 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              {t(`sections.${section.section}`)}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {section.cards.map(({ id, href, icon: Icon }) => (
                <li key={id}>
                  <Link
                    href={href}
                    className="block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Card className="h-full transition-colors hover:bg-accent">
                      <CardContent className="flex items-start gap-3">
                        <span className="rounded-md bg-muted p-2">
                          <Icon className="size-5" aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="block font-medium">{t(`cards.${id}.title`)}</span>
                          <span className="block text-sm text-muted-foreground">
                            {t(`cards.${id}.description`)}
                          </span>
                        </span>
                      </CardContent>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
