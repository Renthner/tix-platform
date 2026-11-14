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
      className="rounded-md border border-warning-border bg-warning-soft p-3 text-sm text-warning"
    >
      <p className="font-medium">{t('maintenanceTitle')}</p>
      <p>{t('maintenanceText')}</p>
    </div>
  );
}
