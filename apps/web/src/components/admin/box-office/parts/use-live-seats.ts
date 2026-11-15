'use client';

import type { SeatDeltaMessage } from '@tix/shared';
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { onRealtime, onResync, subscribeRoom } from '@/lib/realtime';
import { applyInventoryDelta } from './helpers';
import type { Inventory, Pick } from './types';

/** Live updates (same stream as the shop; no shopper heartbeat is sent). */
export function useLiveSeats({
  eventId,
  load,
  invRef,
  setInv,
  setStatusVersion,
  setSeatPicks,
}: {
  eventId: string;
  load: (id: string) => Promise<unknown>;
  invRef: MutableRefObject<Inventory>;
  setInv: Dispatch<SetStateAction<Inventory>>;
  setStatusVersion: Dispatch<SetStateAction<number>>;
  setSeatPicks: Dispatch<SetStateAction<Map<string, Pick>>>;
}) {
  useEffect(() => {
    if (!eventId) return;
    const unsubscribe = subscribeRoom('seats', eventId);
    const off = onRealtime('seats:delta', (payload) => {
      const delta = payload as SeatDeltaMessage;
      if (delta.eventId !== eventId) return;
      if (delta.version !== undefined && delta.version !== invRef.current.version) {
        void load(eventId).catch(() => undefined);
        return;
      }
      setInv((prev) => applyInventoryDelta(prev, delta));
      setStatusVersion((v) => v + 1);
      // A selected seat that was sold meanwhile leaves the selection.
      setSeatPicks((prev) => {
        const sold = delta.seats.filter(([id, s]) => s === 'S' && prev.has(id));
        if (sold.length === 0) return prev;
        const next = new Map(prev);
        for (const [id] of sold) next.delete(id);
        return next;
      });
    });
    const offResync = onResync(() => void load(eventId).catch(() => undefined));
    return () => {
      off();
      offResync();
      unsubscribe();
    };
  }, [eventId, load, invRef, setInv, setStatusVersion, setSeatPicks]);
}
