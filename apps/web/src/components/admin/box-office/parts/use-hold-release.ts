'use client';

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { apiFetch } from '@/lib/api';
import { sectionTotal } from './helpers';
import type { HeldState, Pick } from './types';

/**
 * Only closing / reloading the tab releases the hold; client-side navigation keeps it (the
 * selection is restored when the page is opened again, the TTL frees it otherwise).
 */
export function useHoldRelease({
  eventId,
  tabId,
  load,
  showError,
  setSeatPicks,
  setGaPicks,
  setHoldExpiresAt,
  setStatusVersion,
}: {
  eventId: string;
  tabId: string | null;
  load: (id: string) => Promise<unknown>;
  showError: (err: unknown) => void;
  setSeatPicks: Dispatch<SetStateAction<Map<string, Pick>>>;
  setGaPicks: Dispatch<SetStateAction<Record<string, Record<string, number>>>>;
  setHoldExpiresAt: (value: number | null) => void;
  setStatusVersion: Dispatch<SetStateAction<number>>;
}) {
  useEffect(() => {
    if (!eventId || !tabId) return;
    const release = () =>
      void fetch('/api/admin/box-office/hold', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'release', eventId, tabId }),
      }).catch(() => undefined);
    // Back/forward cache: the page returns without remounting although pagehide released the
    // hold on the server. Re-read what the server still holds so the UI never shows a stale hold.
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void (async () => {
        try {
          await load(eventId);
          const held = await apiFetch<HeldState>(
            `/api/admin/box-office/hold?eventId=${eventId}&tabId=${tabId}`,
          );
          const heldSeats = new Set(held.seatIds);
          setSeatPicks((prev) => new Map([...prev].filter(([seatId]) => heldSeats.has(seatId))));
          setGaPicks((prev) => {
            const next: Record<string, Record<string, number>> = {};
            for (const [sectionId, quantity] of Object.entries(held.ga)) {
              const mine = prev[sectionId];
              if (mine && sectionTotal(mine) === quantity) {
                next[sectionId] = mine;
              }
            }
            return next;
          });
          setHoldExpiresAt(held.expiresAt);
          setStatusVersion((v) => v + 1);
        } catch (err) {
          showError(err);
        }
      })();
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', restored);
    };
  }, [
    eventId,
    tabId,
    load,
    showError,
    setSeatPicks,
    setGaPicks,
    setHoldExpiresAt,
    setStatusVersion,
  ]);
}
