'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { segment: '', key: 'details' },
  { segment: '/sales', key: 'sales' },
  { segment: '/pricing', key: 'pricing' },
  { segment: '/shop-page', key: 'page' },
  { segment: '/seating', key: 'seating' },
  { segment: '/waiting-room', key: 'waitingRoom' },
  { segment: '/access-codes', key: 'accessCodes' },
] as const;

export function EventTabs({ eventId }: { eventId: string }) {
  const t = useTranslations('admin.events.tabs');
  const pathname = usePathname();
  const base = `/admin/events/${eventId}`;
  return (
    <nav className="flex gap-1 overflow-x-auto border-b px-6" aria-label={t('label')}>
      {TABS.map(({ segment, key }) => {
        const href = `${base}${segment}`;
        const active = segment === '' ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={key}
            href={href}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors',
              active
                ? 'border-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}
