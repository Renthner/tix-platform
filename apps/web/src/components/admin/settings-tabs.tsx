'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { SETTINGS_TABS } from '@/lib/settings-tabs';
import { cn } from '@/lib/utils';

export function SettingsTabs() {
  const t = useTranslations('admin.settings.tabs');
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b px-6" aria-label={t('label')}>
      {SETTINGS_TABS.map((tab) => {
        const href = `/admin/settings/${tab}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={tab}
            href={href}
            className={cn(
              '-mb-px border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors',
              active
                ? 'border-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(tab)}
          </Link>
        );
      })}
    </nav>
  );
}
