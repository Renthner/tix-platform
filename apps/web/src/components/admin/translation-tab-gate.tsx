'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { usePathname } from '@/i18n/navigation';

/** Tabs (path segment after the event id) that have translatable texts. */
const TRANSLATABLE_SEGMENTS = new Set([
  '',
  'pricing',
  'fees',
  'shop-page',
  'waiting-room',
  'seating',
]);

/**
 * In a translation language only tabs with translatable texts are shown; the others (sales,
 * ticket design, wallet, access codes) would edit non-translatable settings and show a hint.
 */
export function TranslationTabGate({
  eventId,
  translating,
  children,
}: {
  eventId: string;
  translating: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('translations');
  const pathname = usePathname();
  if (!translating) return <>{children}</>;
  const segment =
    pathname.replace(`/admin/events/${eventId}`, '').replace(/^\//, '').split('/')[0] ?? '';
  if (TRANSLATABLE_SEGMENTS.has(segment)) return <>{children}</>;
  return (
    <Alert>
      <AlertDescription>{t('notTranslatable')}</AlertDescription>
    </Alert>
  );
}
