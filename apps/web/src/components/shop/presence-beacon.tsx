'use client';

import { useEffect } from 'react';
import { HTTP_BEAT_MS, socketPresenceActive } from '@/lib/presence';

/**
 * Lightweight heartbeat for shop pages that have no realtime socket (cart, checkout …): a
 * keep-alive POST every ~20 s while the tab is visible. Pages that report presence through the
 * socket (event page) are skipped, so nobody is counted twice.
 */
export function PresenceBeacon() {
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState !== 'visible' || socketPresenceActive()) return;
      void fetch('/api/session/presence', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        cache: 'no-store',
      }).catch(() => undefined);
    };
    const timer = setInterval(beat, HTTP_BEAT_MS);
    document.addEventListener('visibilitychange', beat);
    beat();
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
    };
  }, []);
  return null;
}
