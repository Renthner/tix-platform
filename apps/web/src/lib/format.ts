'use client';

import { useFormatter } from 'next-intl';
import { useCallback } from 'react';

/** Money in minor units → localised currency string. */
export function useMoney() {
  const format = useFormatter();
  return useCallback(
    (cents: number, currency: string) =>
      format.number(cents / 100, { style: 'currency', currency }),
    [format],
  );
}

/** Event date/time in the event's own time zone. */
export function useEventDate() {
  const format = useFormatter();
  return useCallback(
    (iso: string, timeZone: string) =>
      format.dateTime(new Date(iso), { dateStyle: 'full', timeStyle: 'short', timeZone }),
    [format],
  );
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
