'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const INTERVAL_MS = 12_000;

/**
 * Invisible watcher on the order page while the order awaits a payment (bank transfer, PayPal
 * still processing, open additional payment). Polls the light status endpoint every 12 s while the
 * tab is visible – paused while hidden, checked at once when the tab becomes visible again – and
 * reloads the page data when the status, the paid amount or the open additional payment changed.
 * Works for every payment path (bank matching, PayPal, an admin recording the payment by hand).
 */
export function OrderPaymentWatcher({
  orderId,
  token,
  initial,
}: {
  orderId: string;
  token: string | null;
  initial: { status: string; amountPaid: number; adjustment: string | null };
}) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let inFlight = false;
    const url = `/api/orders/${orderId}/status${token ? `?t=${encodeURIComponent(token)}` : ''}`;
    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!cancelled && !document.hidden) timer = setTimeout(() => void poll(), INTERVAL_MS);
    };
    const poll = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
        if (response.ok) {
          const status = (await response.json()) as typeof initial;
          if (
            status.status !== initial.status ||
            status.amountPaid !== initial.amountPaid ||
            (status.adjustment ?? null) !== initial.adjustment
          ) {
            // New props restart the effect; keep polling in case the refresh did not land.
            if (!cancelled) router.refresh();
          }
        }
      } catch {
        /* next poll retries */
      } finally {
        inFlight = false;
      }
      schedule();
    };
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else {
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [initial.status, initial.amountPaid, initial.adjustment, orderId, router, token]);

  return null;
}
