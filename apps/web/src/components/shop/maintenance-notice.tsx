'use client';

import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';
import { isRealtimeMaintenance, onMaintenanceChange } from '@/lib/realtime';

/**
 * Shown while the realtime gateway reports maintenance (backup restore). The seat chart keeps
 * its last state and resyncs completely after reconnecting (see `onResync`).
 */
export function MaintenanceNotice() {
  const t = useTranslations('shop.selection');
  const active = useSyncExternalStore(onMaintenanceChange, isRealtimeMaintenance, () => false);
  if (!active) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="font-medium">{t('maintenanceTitle')}</p>
      <p>{t('maintenanceText')}</p>
    </div>
  );
}
